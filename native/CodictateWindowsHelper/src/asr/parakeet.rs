use crate::audio::capture::{InputSampleStream, open_input_sample_stream};
use crate::audio::resample::{RECORDING_SAMPLE_RATE, StreamingResampler};
use crate::ipc::emit_json;
use parakeet_rs::{ExecutionConfig, ExecutionProvider, ParakeetTDT, TimestampMode, Transcriber};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

const STREAM_RECV_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Serialize)]
struct FinalTranscriptMessage {
    kind: &'static str,
    text: String,
}

#[derive(Serialize)]
struct SessionReadyMessage {
    kind: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeSessionRequest {
    id: u64,
    audio_path: String,
}

#[derive(Serialize)]
struct SessionFinalTranscriptMessage {
    kind: &'static str,
    id: u64,
    text: String,
}

#[derive(Serialize)]
struct StreamTextEvent<'a> {
    kind: &'static str,
    text: &'a str,
}

#[derive(Serialize)]
struct StreamFinalEvent {
    kind: &'static str,
}

/// Live Transcription's stdout protocol: one NDJSON event per line, read by Bun.
///
/// The helper no longer types into the focused app. It reports what it heard and Bun keeps the
/// running transcript, shows it, and pastes once when the Dictation ends, through the same
/// pipeline a Batch Dictation uses. See docs/adr/0008-live-transcription-stages-in-an-overlay.md.
/// The TypeScript side of this contract is `src/shared/parakeet-stream-protocol.ts`; the macOS
/// helper writes the same three events.
///
/// - `partial` - the current hypothesis for the segment in progress; replaces the last one.
/// - `commit` - a finished segment; clears the partial. An empty commit only clears it.
/// - `final` - the session ended normally, after the last commit.
///
/// Shared by the audio loop and the stop path (the stdin thread and the drain deadline), so
/// every write happens under one lock and only the first `finish` writes `final`; nothing is
/// written after it. The macOS helper's `StreamEventSink` follows the same rule.
#[derive(Default)]
struct StreamEvents {
    state: Mutex<StreamEventsState>,
}

#[derive(Default)]
struct StreamEventsState {
    /// The last partial written and not yet committed. A finish that the audio loop did not
    /// reach commits it, so the words the user saw are the words pasted.
    in_flight_partial: String,
    finished: bool,
}

impl StreamEvents {
    fn lock(&self) -> MutexGuard<'_, StreamEventsState> {
        // A panic while holding the lock leaves nothing half-written that matters more than
        // still being able to write `final`.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn partial(&self, text: &str) -> Result<(), String> {
        let mut state = self.lock();
        if state.finished {
            return Ok(());
        }
        state.in_flight_partial = text.to_string();
        emit_text_event("partial", text)
    }

    fn commit(&self, text: &str) -> Result<(), String> {
        let mut state = self.lock();
        if state.finished {
            return Ok(());
        }
        if text.is_empty() && state.in_flight_partial.is_empty() {
            return Ok(());
        }
        state.in_flight_partial.clear();
        emit_text_event("commit", text)
    }

    /// Ends the session normally: commits the partial still in flight, if any, then writes
    /// `final`. Does nothing when the session already finished. Each event is flushed as it is
    /// written (`emit_json`).
    fn finish(&self) -> Result<(), String> {
        let mut state = self.lock();
        Self::finish_locked(&mut state)
    }

    /// `finish`, then exit the process at once - from the stop path, while the audio loop may
    /// still be inside a model load or a transcription pass that cannot be interrupted. The lock
    /// is held until the process is gone, so the loop cannot write after `final`. Exits 0 when
    /// `final` was written (by this caller or an earlier one), 1 when writing it failed.
    fn finish_and_exit(&self) -> ! {
        let mut state = self.lock();
        let code = match Self::finish_locked(&mut state) {
            Ok(()) => 0,
            Err(err) => {
                log_phase(format!("stream: {err}"));
                1
            }
        };
        std::process::exit(code)
    }

    fn finish_locked(state: &mut StreamEventsState) -> Result<(), String> {
        if state.finished {
            return Ok(());
        }
        state.finished = true;
        let pending = clean_transcript(&std::mem::take(&mut state.in_flight_partial));
        if !pending.is_empty() {
            emit_text_event("commit", &pending)?;
        }
        emit_json(&StreamFinalEvent { kind: "final" })
            .map_err(|err| format!("failed to write final event: {err}"))
    }
}

fn emit_text_event(kind: &'static str, text: &str) -> Result<(), String> {
    emit_json(&StreamTextEvent { kind, text })
        .map_err(|err| format!("failed to write {kind} event: {err}"))
}

/// How long the audio loop gets to finish its last segment after a stop, matching the macOS
/// helper's `StreamStopRequest.drainDeadlineSeconds`. Bun kills a helper that has not exited
/// 6s after the stop (`STREAM_STOP_DEADLINE_MS`) and reports the session as failed; this keeps
/// the helper well inside that.
const STREAM_STOP_DRAIN_DEADLINE: Duration = Duration::from_secs(3);

/// What a stop does, decided by whether one already arrived and whether the audio loop exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopResponse {
    /// No audio loop to drain yet - the model is still loading, or the input is opening. Write
    /// `final` and exit now: nothing was heard, and the load alone can outlast Bun's deadline.
    FinishNow,
    /// The audio loop is running. Let it drain and commit the segment in progress, under
    /// `STREAM_STOP_DRAIN_DEADLINE`.
    DrainUnderDeadline,
    /// A stop is already being handled.
    AlreadyStopping,
}

fn stop_response(already_requested: bool, audio_loop_running: bool) -> StopResponse {
    match (already_requested, audio_loop_running) {
        (true, _) => StopResponse::AlreadyStopping,
        (false, true) => StopResponse::DrainUnderDeadline,
        (false, false) => StopResponse::FinishNow,
    }
}

/// The stop half of a stream session. The audio loop polls `is_requested`; the stdin thread
/// calls `request`. The lock makes "the loop starts" and "a stop arrives" one ordering, so a
/// stop is either seen by a running loop or finishes the session itself, never neither.
#[derive(Default)]
struct StreamStop {
    requested: AtomicBool,
    state: Mutex<StreamStopState>,
}

#[derive(Default)]
struct StreamStopState {
    requested: bool,
    audio_loop_running: bool,
}

impl StreamStop {
    fn lock(&self) -> MutexGuard<'_, StreamStopState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_requested(&self) -> bool {
        self.requested.load(AtomicOrdering::SeqCst)
    }

    /// The audio loop is about to run. False when a stop got here first: its handler has
    /// already finished the session, and the loop must not start.
    fn begin_audio_loop(&self) -> bool {
        let mut state = self.lock();
        if state.requested {
            return false;
        }
        state.audio_loop_running = true;
        true
    }

    fn request(&self) -> StopResponse {
        let mut state = self.lock();
        let response = stop_response(state.requested, state.audio_loop_running);
        state.requested = true;
        self.requested.store(true, AtomicOrdering::SeqCst);
        response
    }
}

/// One Live Transcription session's shared state: what has been written, and whether it is
/// stopping. Shared by the audio loop, the stdin thread and the drain deadline.
#[derive(Default)]
struct StreamSession {
    events: StreamEvents,
    stop: StreamStop,
}

/// Every stop lands here. A stop before the audio loop exists finishes the session at once; the
/// first stop once it runs arms the drain deadline, which finishes the session with the last
/// partial if the loop has not finished it by then.
fn handle_stream_stop(session: &Arc<StreamSession>, source: &str) {
    let response = session.stop.request();
    log_phase(format!("stream: stop requested ({source}): {response:?}"));
    match response {
        StopResponse::FinishNow => session.events.finish_and_exit(),
        StopResponse::DrainUnderDeadline => {
            let session = Arc::clone(session);
            thread::spawn(move || {
                thread::sleep(STREAM_STOP_DRAIN_DEADLINE);
                log_phase("stream: drain deadline passed - finishing with the last partial");
                session.events.finish_and_exit();
            });
        }
        StopResponse::AlreadyStopping => {}
    }
}

/// The stream session's stop channel: a `stop` line on stdin, or stdin closing (the host went
/// away, or Bun closed the pipe after writing `stop`). Bun cannot signal a Windows process
/// gracefully. Only the first of those counts: Bun writes `stop` and closes stdin straight
/// after, and that close must not cut the drain short.
///
/// A `cancel` line ends the session at once instead: Bun will not paste this session's text
/// (Escape, or a stop the app made), so it commits the partial last written, writes `final`
/// and exits 0 with no final transcription pass, letting Bun release the Dictation pipeline
/// straight away. The macOS helper reads the same two lines.
fn spawn_stream_stdin_thread(session: Arc<StreamSession>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            match stream_control_command(&line) {
                Some(StreamControlCommand::Stop) => {
                    handle_stream_stop(&session, "stdin stop");
                    return;
                }
                Some(StreamControlCommand::Cancel) => {
                    log_phase("stream: cancel requested (stdin) - finishing without a final pass");
                    session.events.finish_and_exit();
                }
                None => {}
            }
        }
        handle_stream_stop(&session, "stdin closed");
    })
}

/// A line Bun writes to a stream session's stdin. `src/shared/parakeet-stream-protocol.ts`
/// (`StreamStopCommand`) is the other side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamControlCommand {
    Stop,
    Cancel,
}

fn stream_control_command(line: &str) -> Option<StreamControlCommand> {
    let line = line.trim();
    if line.eq_ignore_ascii_case("stop") {
        Some(StreamControlCommand::Stop)
    } else if line.eq_ignore_ascii_case("cancel") {
        Some(StreamControlCommand::Cancel)
    } else {
        None
    }
}

fn log_phase(message: impl AsRef<str>) {
    let _ = writeln!(
        io::stderr().lock(),
        "[CodictateWindowsHelper:parakeet] {}",
        message.as_ref()
    );
}

fn base_execution_config() -> ExecutionConfig {
    let threads = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(2, 8);
    ExecutionConfig::new()
        .with_intra_threads(threads)
        .with_inter_threads(1)
}

fn load_model(model_dir: &str) -> Result<ParakeetTDT, String> {
    log_phase("loading ONNX Parakeet TDT model with DirectML...");
    let directml_config =
        base_execution_config().with_execution_provider(ExecutionProvider::DirectML);
    match ParakeetTDT::from_pretrained(model_dir, Some(directml_config)) {
        Ok(model) => {
            log_phase("loaded ONNX Parakeet TDT model with DirectML");
            Ok(model)
        }
        Err(err) => {
            log_phase(format!(
                "DirectML model load failed, falling back to CPU: {err}"
            ));
            ParakeetTDT::from_pretrained(model_dir, Some(base_execution_config()))
                .map_err(|cpu_err| format!("failed to load Parakeet ONNX model: {cpu_err}"))
        }
    }
}

fn clean_transcript(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn transcribe_samples(model: &mut ParakeetTDT, samples: Vec<f32>) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }
    let result = model
        .transcribe_samples(
            samples,
            RECORDING_SAMPLE_RATE,
            1,
            Some(TimestampMode::Sentences),
        )
        .map_err(|err| format!("Parakeet transcription failed: {err}"))?;
    Ok(clean_transcript(&result.text))
}

fn transcribe_for_stream(model: &mut ParakeetTDT, samples: &[f32]) -> Option<String> {
    match transcribe_samples(model, samples.to_vec()) {
        Ok(text) => Some(text),
        Err(err) => {
            log_phase(format!("stream transcription error: {err}"));
            None
        }
    }
}

fn push_mono_frame(frame: &[f32], out: &mut Vec<f32>) {
    if frame.is_empty() {
        return;
    }
    let sum: f32 = frame.iter().copied().sum();
    out.push((sum / frame.len() as f32).clamp(-1.0, 1.0));
}

fn load_wav_mono_f32(path: &str) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(Path::new(path))
        .map_err(|err| format!("failed to open wav: {err}"))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels == 0 {
        return Err("wav has zero channels".to_string());
    }

    let mut samples = Vec::new();
    match spec.sample_format {
        hound::SampleFormat::Float => {
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<f32>() {
                frame.push(sample.map_err(|err| format!("invalid float sample: {err}"))?);
                if frame.len() == channels {
                    push_mono_frame(&frame, &mut samples);
                    frame.clear();
                }
            }
        }
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => {
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<i16>() {
                frame.push(
                    sample.map_err(|err| format!("invalid i16 sample: {err}"))? as f32 / 32768.0,
                );
                if frame.len() == channels {
                    push_mono_frame(&frame, &mut samples);
                    frame.clear();
                }
            }
        }
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) as f32;
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<i32>() {
                frame.push(
                    (sample.map_err(|err| format!("invalid i32 sample: {err}"))? as f32 / scale)
                        .clamp(-1.0, 1.0),
                );
                if frame.len() == channels {
                    push_mono_frame(&frame, &mut samples);
                    frame.clear();
                }
            }
        }
    }

    Ok((samples, spec.sample_rate))
}

fn resample_to_recording_rate(samples: &[f32], sample_rate: u32) -> Result<Vec<f32>, String> {
    let mut out = Vec::new();
    let mut resampler = StreamingResampler::new(sample_rate)?;
    resampler.process(samples, |chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    })?;
    resampler.finish(|chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok(out)
}

fn transcribe_wav(model: &mut ParakeetTDT, wav_path: &str) -> Result<String, String> {
    let (samples, sample_rate) = load_wav_mono_f32(wav_path)?;
    let samples = resample_to_recording_rate(&samples, sample_rate)?;
    transcribe_samples(model, samples)
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy: f32 = samples.iter().map(|sample| sample * sample).sum();
    (energy / samples.len() as f32).sqrt()
}

fn resolve_live_utterance_text(final_raw: &str, last_partial: &str) -> String {
    let final_text = clean_transcript(final_raw);
    if !final_text.is_empty() {
        final_text
    } else {
        clean_transcript(last_partial)
    }
}

pub fn handle_transcribe(args: &[String]) -> ExitCode {
    if args.len() < 4 {
        eprintln!("CodictateWindowsHelper transcribe <wavPath> <parakeetModelDir>");
        return ExitCode::from(1);
    }

    let wav_path = &args[2];
    let model_dir = &args[3];
    let result = (|| -> Result<String, String> {
        let mut model = load_model(model_dir)?;
        log_phase("transcribing wav...");
        transcribe_wav(&mut model, wav_path)
    })();

    match result {
        Ok(text) => match emit_json(&FinalTranscriptMessage {
            kind: "final",
            text,
        }) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("CodictateWindowsHelper transcribe failed to write JSON: {err}");
                ExitCode::from(1)
            }
        },
        Err(err) => {
            eprintln!("CodictateWindowsHelper transcribe failed: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_transcribe_session(args: &[String]) -> ExitCode {
    if args.len() < 3 {
        eprintln!("CodictateWindowsHelper transcribe-session <parakeetModelDir>");
        return ExitCode::from(1);
    }

    let model_dir = &args[2];
    let result = (|| -> Result<(), String> {
        let mut model = load_model(model_dir)?;
        emit_json(&SessionReadyMessage { kind: "ready" })
            .map_err(|err| format!("failed to write ready response: {err}"))?;

        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = line.map_err(|err| format!("failed to read session request: {err}"))?;
            if line.trim().is_empty() {
                continue;
            }
            let request: TranscribeSessionRequest = serde_json::from_str(&line)
                .map_err(|err| format!("invalid transcribe-session request: {err}"))?;
            if request.audio_path.is_empty() {
                return Err("invalid transcribe-session request: audioPath is empty".to_string());
            }

            log_phase(format!("transcribe session request {}...", request.id));
            let text = transcribe_wav(&mut model, &request.audio_path)?;
            emit_json(&SessionFinalTranscriptMessage {
                kind: "final",
                id: request.id,
                text,
            })
            .map_err(|err| format!("failed to write session response: {err}"))?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper transcribe-session failed: {err}");
            ExitCode::from(1)
        }
    }
}

pub fn handle_stream(args: &[String]) -> ExitCode {
    if args.len() < 4 {
        eprintln!(
            "CodictateWindowsHelper stream <vad|live> <parakeetModelDir> [deviceIndexOrEndpointId]"
        );
        return ExitCode::from(1);
    }

    let mode = &args[2];
    let model_dir = &args[3];
    let device_ref = args.get(4).map(String::as_str);
    // Started before the model load, so a stop that lands during it still ends the session
    // with a `final` instead of waiting out a DirectML load. See `handle_stream_stop`.
    let session = Arc::new(StreamSession::default());
    let _stdin_thread = spawn_stream_stdin_thread(Arc::clone(&session));
    let result = match mode.as_str() {
        "vad" => run_vad_stream(model_dir, device_ref, &session),
        "live" => run_live_stream(model_dir, device_ref, &session),
        other => Err(format!("unknown stream mode: {other}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("CodictateWindowsHelper stream failed: {err}");
            ExitCode::from(1)
        }
    }
}

fn run_vad_stream(
    model_dir: &str,
    device_ref: Option<&str>,
    session: &StreamSession,
) -> Result<(), String> {
    let mut model = load_model(model_dir)?;
    let events = &session.events;
    if session.stop.is_requested() {
        log_phase("stream [vad]: stopped before audio input opened");
        return events.finish();
    }
    let input = open_input_sample_stream(device_ref)?;
    let mut resampler = StreamingResampler::new(input.sample_rate)?;
    if !session.stop.begin_audio_loop() {
        log_phase("stream [vad]: stopped while audio input opened");
        drop(input);
        return events.finish();
    }
    log_phase("stream [vad]: audio input running");

    const RMS_THRESHOLD: f32 = 0.012;
    const SILENCE_COMMIT: usize = 8_000;
    const MIN_UTTERANCE: usize = 8_000;
    const MAX_UTTERANCE: usize = RECORDING_SAMPLE_RATE as usize * 30;

    let mut utterance = Vec::<f32>::new();
    let mut in_speech = false;
    let mut silence_accum = 0usize;

    loop {
        if session.stop.is_requested() {
            log_phase("stream [vad]: stop requested");
            break;
        }
        let input_chunk = match input.recv_timeout(STREAM_RECV_TIMEOUT) {
            Ok(chunk) => chunk,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                return Err("audio input disconnected mid-session".to_string());
            }
        };

        resampler.process(&input_chunk, |chunk| {
            let chunk_rms = rms(chunk);
            if chunk_rms >= RMS_THRESHOLD {
                silence_accum = 0;
                if !in_speech {
                    in_speech = true;
                    utterance.clear();
                    log_phase("stream [vad]: speech start");
                }
                utterance.extend_from_slice(chunk);
                if utterance.len() >= MAX_UTTERANCE {
                    if let Some(text) = transcribe_for_stream(&mut model, &utterance)
                        && !text.is_empty()
                    {
                        events.commit(&text)?;
                    }
                    utterance.clear();
                }
            } else if in_speech {
                utterance.extend_from_slice(chunk);
                silence_accum += chunk.len();
                if silence_accum >= SILENCE_COMMIT {
                    in_speech = false;
                    silence_accum = 0;
                    log_phase(format!(
                        "stream [vad]: speech end, transcribing {} samples",
                        utterance.len()
                    ));
                    if utterance.len() >= MIN_UTTERANCE
                        && let Some(text) = transcribe_for_stream(&mut model, &utterance)
                        && !text.is_empty()
                    {
                        events.commit(&text)?;
                    }
                    utterance.clear();
                }
            }
            Ok(())
        })?;
    }

    // Audio still queued behind the last pass is the end of what the user said before the
    // stop. It only extends the utterance in progress; no transcription runs on it here.
    drain_after_stop(input, &mut resampler, |chunk| {
        if in_speech {
            utterance.extend_from_slice(chunk);
        }
    })?;
    // Stopped mid-utterance: the speech never reached its silence commit, and with push-to-talk
    // that is the usual case for the last thing said.
    if in_speech
        && utterance.len() >= MIN_UTTERANCE
        && let Some(text) = transcribe_for_stream(&mut model, &utterance)
        && !text.is_empty()
    {
        log_phase("stream [vad]: committed the utterance in progress at stop");
        events.commit(&text)?;
    }
    events.finish()
}

fn run_live_stream(
    model_dir: &str,
    device_ref: Option<&str>,
    session: &StreamSession,
) -> Result<(), String> {
    let mut model = load_model(model_dir)?;
    let events = &session.events;
    if session.stop.is_requested() {
        log_phase("stream [live]: stopped before audio input opened");
        return events.finish();
    }
    let input = open_input_sample_stream(device_ref)?;
    let mut resampler = StreamingResampler::new(input.sample_rate)?;
    if !session.stop.begin_audio_loop() {
        log_phase("stream [live]: stopped while audio input opened");
        drop(input);
        return events.finish();
    }
    log_phase("stream [live]: audio input running");

    const RMS_THRESHOLD: f32 = 0.010;
    const SILENCE_COMMIT: usize = 24_000;
    const MIN_UTTERANCE: usize = 2_400;
    const MIN_SAMPLES_FOR_INFER: usize = RECORDING_SAMPLE_RATE as usize;
    const MIN_SAMPLES_BETWEEN_UPDATES: usize = 4_800;
    const MAX_UTTERANCE: usize = RECORDING_SAMPLE_RATE as usize * 20;

    let mut utterance = Vec::<f32>::new();
    let mut in_speech = false;
    let mut silence_accum = 0usize;
    let mut samples_since_last_update = 0usize;
    let mut last_partial_text = String::new();

    loop {
        if session.stop.is_requested() {
            log_phase("stream [live]: stop requested");
            break;
        }
        let input_chunk = match input.recv_timeout(STREAM_RECV_TIMEOUT) {
            Ok(chunk) => chunk,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                return Err("audio input disconnected mid-session".to_string());
            }
        };

        resampler.process(&input_chunk, |chunk| {
            let chunk_rms = rms(chunk);
            match chunk_rms.partial_cmp(&RMS_THRESHOLD) {
                Some(Ordering::Greater | Ordering::Equal) => {
                    silence_accum = 0;
                    if !in_speech {
                        in_speech = true;
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_partial_text.clear();
                        log_phase("stream [live]: voice active");
                    }

                    utterance.extend_from_slice(chunk);
                    samples_since_last_update += chunk.len();

                    // Stopping: a partial pass nobody will see would only spend the drain
                    // deadline the stop commit needs.
                    let should_emit_update = utterance.len() >= MIN_SAMPLES_FOR_INFER
                        && samples_since_last_update >= MIN_SAMPLES_BETWEEN_UPDATES
                        && !session.stop.is_requested();
                    if should_emit_update {
                        samples_since_last_update = 0;
                        if let Some(partial_text) = transcribe_for_stream(&mut model, &utterance)
                            && !partial_text.is_empty()
                            && partial_text != last_partial_text
                        {
                            events.partial(&partial_text)?;
                            last_partial_text = partial_text;
                        }
                    }

                    if utterance.len() >= MAX_UTTERANCE {
                        commit_live_utterance(&mut model, events, &utterance, &last_partial_text)?;
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_partial_text.clear();
                    }
                }
                _ if in_speech => {
                    utterance.extend_from_slice(chunk);
                    silence_accum += chunk.len();

                    if silence_accum >= SILENCE_COMMIT {
                        in_speech = false;
                        silence_accum = 0;
                        log_phase("stream [live]: silence commit");
                        if utterance.len() >= MIN_UTTERANCE || !last_partial_text.is_empty() {
                            commit_live_utterance(
                                &mut model,
                                events,
                                &utterance,
                                &last_partial_text,
                            )?;
                        }
                        utterance.clear();
                        samples_since_last_update = 0;
                        last_partial_text.clear();
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
    }

    // Same as the vad loop: queued audio extends the segment in progress, and no partial pass
    // runs on it - nobody would see one, and the stop commit below transcribes all of it.
    drain_after_stop(input, &mut resampler, |chunk| {
        if in_speech {
            utterance.extend_from_slice(chunk);
        }
    })?;
    // Stopped mid-segment, which with push-to-talk is how the last segment always ends.
    if in_speech && (utterance.len() >= MIN_UTTERANCE || !last_partial_text.is_empty()) {
        log_phase("stream [live]: stop commit");
        commit_live_utterance(&mut model, events, &utterance, &last_partial_text)?;
    }
    events.finish()
}

/// Stops capture, then feeds every chunk still queued in the input channel - and the
/// resampler's own tail - to `on_chunk` at the recording rate. Without this a stop dropped
/// whatever the capture thread had queued while the loop was busy in a transcription pass,
/// which is the last words before a push-to-talk release. The macOS helper delivers its queued
/// chunks the same way before its loop ends.
fn drain_after_stop(
    input: InputSampleStream,
    resampler: &mut StreamingResampler,
    mut on_chunk: impl FnMut(&[f32]),
) -> Result<(), String> {
    let queued = input.stop_and_drain();
    let queued_samples: usize = queued.iter().map(Vec::len).sum();
    for input_chunk in &queued {
        resampler.process(input_chunk, |chunk| {
            on_chunk(chunk);
            Ok(())
        })?;
    }
    resampler.finish(|chunk| {
        on_chunk(chunk);
        Ok(())
    })?;
    log_phase(format!(
        "stream: drained {} queued chunks ({} input samples) after stop",
        queued.len(),
        queued_samples
    ));
    Ok(())
}

/// The segment's final pass, written as a `commit`. Falls back to the last partial when the
/// full-buffer pass fails or comes back empty, so a segment the user watched does not vanish.
fn commit_live_utterance(
    model: &mut ParakeetTDT,
    events: &StreamEvents,
    utterance: &[f32],
    last_partial_text: &str,
) -> Result<(), String> {
    let final_text = match transcribe_for_stream(model, utterance) {
        Some(raw) => resolve_live_utterance_text(&raw, last_partial_text),
        None => clean_transcript(last_partial_text),
    };
    events.commit(&final_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_request_uses_the_shared_camel_case_contract() {
        let request: TranscribeSessionRequest =
            serde_json::from_str(r#"{"id":7,"audioPath":"C:\\clips\\sample.wav"}"#)
                .expect("request should decode");

        assert_eq!(request.id, 7);
        assert_eq!(request.audio_path, r"C:\clips\sample.wav");
        assert!(
            serde_json::from_str::<TranscribeSessionRequest>(
                r#"{"id":-1,"audioPath":"sample.wav"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<TranscribeSessionRequest>(
                r#"{"id":1.5,"audioPath":"sample.wav"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn session_messages_emit_ready_and_correlated_final_shapes() {
        let ready = serde_json::to_string(&SessionReadyMessage { kind: "ready" })
            .expect("ready response should encode");
        let final_response = serde_json::to_string(&SessionFinalTranscriptMessage {
            kind: "final",
            id: 7,
            text: "hej verden".to_string(),
        })
        .expect("final response should encode");

        assert_eq!(ready, r#"{"kind":"ready"}"#);
        assert_eq!(
            final_response,
            r#"{"kind":"final","id":7,"text":"hej verden"}"#
        );
    }

    #[test]
    fn stream_events_emit_the_shared_protocol_shapes() {
        let partial = serde_json::to_string(&StreamTextEvent {
            kind: "partial",
            text: "hello wor",
        })
        .expect("partial event should encode");
        let commit = serde_json::to_string(&StreamTextEvent {
            kind: "commit",
            text: "hello world",
        })
        .expect("commit event should encode");
        let final_event = serde_json::to_string(&StreamFinalEvent { kind: "final" })
            .expect("final event should encode");

        assert_eq!(partial, r#"{"kind":"partial","text":"hello wor"}"#);
        assert_eq!(commit, r#"{"kind":"commit","text":"hello world"}"#);
        assert_eq!(final_event, r#"{"kind":"final"}"#);
    }
}

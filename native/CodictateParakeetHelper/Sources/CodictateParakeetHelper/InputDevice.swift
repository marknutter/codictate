@preconcurrency import AVFoundation
import CoreAudio
import Foundation

/// Microphone selection for stream mode.
///
/// Bun passes the same device index it gives MicRecorder for a Batch Dictation, so the index
/// must mean the same thing here: a position in the input-capable devices sorted by
/// AudioDeviceID (MicRecorder's `listInputDevices`). Unlike MicRecorder, this never touches
/// the system default input: it points only this process's AVAudioEngine at the device.
enum InputDevice {
  private static func hasInput(_ id: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamConfiguration,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0
    else { return false }

    let raw = UnsafeMutableRawPointer.allocate(
      byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else {
      return false
    }
    let buffers = UnsafeMutableAudioBufferListPointer(
      raw.assumingMemoryBound(to: AudioBufferList.self))
    return buffers.reduce(0) { $0 + Int($1.mNumberChannels) } > 0
  }

  private static func name(_ id: AudioDeviceID) -> String {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioObjectPropertyName,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var cfName: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    let err = withUnsafeMutablePointer(to: &cfName) { ptr in
      AudioObjectGetPropertyData(id, &address, 0, nil, &size, ptr)
    }
    if err == noErr, let s = cfName { return s as String }
    return "Device \(id)"
  }

  /// Input-capable devices sorted by AudioDeviceID, matching MicRecorder's indices.
  static func list() -> [(AudioDeviceID, String)] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else {
      return []
    }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else {
      return []
    }
    return ids.filter(hasInput).sorted().map { ($0, name($0)) }
  }

  /// Parse the optional device argument. Absent means the system default input.
  static func parseIndex(_ arg: String?) throws -> Int? {
    guard let arg else { return nil }
    guard let index = Int(arg), index >= 0 else {
      throw NSError(
        domain: "CodictateParakeet", code: 10,
        userInfo: [NSLocalizedDescriptionKey: "Invalid input device index: \(arg)"])
    }
    return index
  }

  /// Point the engine's input node at the device with this index. Must run before the input
  /// node's format is read or a tap is installed. A missing device is an error, never a
  /// silent switch to another microphone.
  static func select(index: Int, on engine: AVAudioEngine) throws {
    let devices = list()
    guard index < devices.count else {
      throw NSError(
        domain: "CodictateParakeet", code: 11,
        userInfo: [
          NSLocalizedDescriptionKey:
            "Input device \(index) not found (\(devices.count) input devices present)"
        ])
    }
    let (deviceID, deviceName) = devices[index]
    guard let unit = engine.inputNode.audioUnit else {
      throw NSError(
        domain: "CodictateParakeet", code: 12,
        userInfo: [NSLocalizedDescriptionKey: "Input node has no audio unit"])
    }
    var id = deviceID
    let status = AudioUnitSetProperty(
      unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id,
      UInt32(MemoryLayout<AudioDeviceID>.size))
    guard status == noErr else {
      throw NSError(
        domain: "CodictateParakeet", code: 13,
        userInfo: [
          NSLocalizedDescriptionKey:
            "Cannot select input device \(index) (\(deviceName)): OSStatus \(status)"
        ])
    }
    logPhase("stream: input device \(index) — \(deviceName)")
  }
}

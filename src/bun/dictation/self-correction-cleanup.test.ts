/**
 * The pure parts of the Self-correction Cleanup step: what one transcript gets, whether a
 * model answer is accepted, and the Qwen output budget. Written against the spec for issue
 * #13 (ADR-0006, ADR-0007), not the implementation. `applySelfCorrectionCleanup` runs
 * inference and is deliberately not exercised here.
 */

import { describe, expect, test } from 'bun:test'
import type {
  FormatterModelTier,
  FormattingRuntimeSettings,
  S1FormattingSettings,
} from '../../shared/types'
import {
  acceptSelfCorrectionOutput,
  resolveSelfCorrectionCleanupStep,
  selfCorrectionMaxTokens,
} from './self-correction-cleanup'

type StepSettings = Pick<
  FormattingRuntimeSettings,
  | 'selfCorrectionCleanup'
  | 'formatterModelTier'
  | 'enabled'
  | 'transcriptionLanguageId'
  | 's1'
>

const S1: S1FormattingSettings = { styling: 'formal', structure: 'lists' }
const TRANSCRIPT = 'Meet me at three, no, four tomorrow afternoon.'
const QWEN_TIERS: Exclude<FormatterModelTier, 's1-mini'>[] = ['fast', 'quality']

function settings(overrides: Partial<StepSettings> = {}): StepSettings {
  return {
    selfCorrectionCleanup: true,
    formatterModelTier: 'fast',
    enabled: false,
    transcriptionLanguageId: 'en',
    s1: S1,
    ...overrides,
  }
}

describe('resolveSelfCorrectionCleanupStep', () => {
  const ALL_TIERS: FormatterModelTier[] = ['fast', 'quality', 's1-mini']

  for (const tier of ALL_TIERS) {
    for (const enabled of [false, true]) {
      test(`skips when the setting is off (${tier}, Auto-polish ${enabled ? 'on' : 'off'})`, () => {
        const step = resolveSelfCorrectionCleanupStep(
          TRANSCRIPT,
          settings({
            selfCorrectionCleanup: false,
            formatterModelTier: tier,
            enabled,
          })
        )
        expect(step).toEqual({ kind: 'skip', reason: 'setting_off' })
      })
    }
  }

  test('skips an empty transcript with the setting on', () => {
    const step = resolveSelfCorrectionCleanupStep('', settings())
    expect(step).toEqual({ kind: 'skip', reason: 'empty_transcript' })
  })

  describe('Qwen', () => {
    for (const tier of QWEN_TIERS) {
      for (const languageId of ['en', 'da', 'de', 'zh-cn', 'auto']) {
        test(`runs Qwen ${tier} for language ${languageId}`, () => {
          const step = resolveSelfCorrectionCleanupStep(
            TRANSCRIPT,
            settings({
              formatterModelTier: tier,
              transcriptionLanguageId: languageId,
            })
          )
          expect(step).toEqual({ kind: 'qwen', modelTier: tier, languageId })
        })
      }

      test(`runs Qwen ${tier} whether or not Auto-polish is on`, () => {
        for (const enabled of [false, true]) {
          const step = resolveSelfCorrectionCleanupStep(
            TRANSCRIPT,
            settings({ formatterModelTier: tier, enabled })
          )
          expect(step.kind).toBe('qwen')
        }
      })
    }

    test('runs Qwen on a Danish transcript', () => {
      const step = resolveSelfCorrectionCleanupStep(
        'Vi ses klokken tre, nej, fire i morgen eftermiddag.',
        settings({
          formatterModelTier: 'quality',
          transcriptionLanguageId: 'da',
        })
      )
      expect(step.kind).toBe('qwen')
    })
  })

  describe('S1-mini', () => {
    test('runs S1-mini once on an English transcript when Auto-polish is off', () => {
      const step = resolveSelfCorrectionCleanupStep(
        TRANSCRIPT,
        settings({ formatterModelTier: 's1-mini', enabled: false })
      )
      expect(step.kind).toBe('s1-mini')
    })

    test('the S1-mini pass uses the general style with prose structure (no bullets)', () => {
      const step = resolveSelfCorrectionCleanupStep(
        TRANSCRIPT,
        settings({ formatterModelTier: 's1-mini', enabled: false })
      )
      expect(step.kind).toBe('s1-mini')
      if (step.kind !== 's1-mini') return
      expect(step.controls.styling).toBe(S1.styling)
      expect(step.controls.structure).toBe('prose')
    })

    test('skips when Auto-polish is on and the transcript is English (never S1-mini twice)', () => {
      const step = resolveSelfCorrectionCleanupStep(
        TRANSCRIPT,
        settings({ formatterModelTier: 's1-mini', enabled: true })
      )
      expect(step).toEqual({
        kind: 'skip',
        reason: 's1_formatting_mode_resolves',
      })
    })

    for (const enabled of [false, true]) {
      test(`skips a non-English transcript, never switching to Qwen (Auto-polish ${enabled ? 'on' : 'off'})`, () => {
        const step = resolveSelfCorrectionCleanupStep(
          'Vi ses klokken tre, nej, fire i morgen eftermiddag.',
          settings({
            formatterModelTier: 's1-mini',
            transcriptionLanguageId: 'da',
            enabled,
          })
        )
        expect(step).toEqual({ kind: 'skip', reason: 's1_not_english' })
      })
    }

    test('skips a German transcript with a fixed German language', () => {
      const step = resolveSelfCorrectionCleanupStep(
        'Wir treffen uns um drei, nein, um vier Uhr morgen.',
        settings({
          formatterModelTier: 's1-mini',
          transcriptionLanguageId: 'de',
        })
      )
      expect(step).toEqual({ kind: 'skip', reason: 's1_not_english' })
    })
  })
})

describe('acceptSelfCorrectionOutput', () => {
  test.each(['', ' ', '\n\t  \n'])(
    'rejects an empty or whitespace-only result (%j) for non-empty input',
    (output) => {
      expect(acceptSelfCorrectionOutput(TRANSCRIPT, output)).toBeNull()
    }
  )

  test('accepts a non-empty result', () => {
    expect(
      acceptSelfCorrectionOutput(
        TRANSCRIPT,
        'Meet me at four tomorrow afternoon.'
      )
    ).toBe('Meet me at four tomorrow afternoon.')
  })

  test('returns the accepted result trimmed', () => {
    expect(
      acceptSelfCorrectionOutput(
        TRANSCRIPT,
        '  Meet me at four tomorrow afternoon.\n'
      )
    ).toBe('Meet me at four tomorrow afternoon.')
  })

  test('accepts a result identical to the input', () => {
    expect(acceptSelfCorrectionOutput(TRANSCRIPT, TRANSCRIPT)).toBe(TRANSCRIPT)
  })
})

describe('selfCorrectionMaxTokens', () => {
  const lengths = [0, 1, 10, 50, 100, 500, 1_000, 5_000, 20_000, 100_000]

  test.each(lengths)(
    'is positive and finite for a %d-character transcript',
    (n) => {
      const tokens = selfCorrectionMaxTokens('a'.repeat(n))
      expect(Number.isFinite(tokens)).toBe(true)
      expect(tokens).toBeGreaterThan(0)
    }
  )

  test('never shrinks as the transcript grows', () => {
    let previous = 0
    for (const n of lengths) {
      const tokens = selfCorrectionMaxTokens('word '.repeat(n))
      expect(tokens).toBeGreaterThanOrEqual(previous)
      previous = tokens
    }
  })

  test('a long transcript gets a larger budget than a short one', () => {
    expect(selfCorrectionMaxTokens('word '.repeat(2_000))).toBeGreaterThan(
      selfCorrectionMaxTokens('Hi.')
    )
  })
})

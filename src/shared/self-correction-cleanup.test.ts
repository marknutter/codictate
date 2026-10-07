/**
 * Self-correction Cleanup's ADR-0005 arms - readiness, the write, the heal - exercised with
 * nothing but a settings object and an availability snapshot. Written against the spec for
 * issue #13, not the implementation.
 */

import { describe, expect, test } from 'bun:test'
import {
  applySelfCorrectionCleanupPatch,
  FORMATTING_MODEL_LABELS,
  getSelfCorrectionCleanupReadiness,
  healSelfCorrectionCleanup,
  selfCorrectionCleanupHealMessage,
  type SelfCorrectionCleanupAvailability,
  type SelfCorrectionCleanupReadinessReason,
  type SelfCorrectionCleanupSettings,
} from './self-correction-cleanup'
import type { FormatterModelTier } from './types'

const ALL_TIERS: FormatterModelTier[] = ['fast', 'quality', 's1-mini']
const ALL_REASONS: SelfCorrectionCleanupReadinessReason[] = [
  'formatting_runtime_missing',
  'formatting_model_not_installed',
]

/** `installed` lists the Formatting Models whose weights are on disk. */
function availability(
  installed: FormatterModelTier[],
  formattingAvailable = true
): SelfCorrectionCleanupAvailability {
  return {
    formattingAvailable,
    modelAvailability: {
      fast: installed.includes('fast'),
      quality: installed.includes('quality'),
      's1-mini': installed.includes('s1-mini'),
    },
  }
}

function settings(
  overrides: Partial<SelfCorrectionCleanupSettings> = {}
): SelfCorrectionCleanupSettings {
  return {
    selfCorrectionCleanup: false,
    formatterModelTier: 'fast',
    ...overrides,
  }
}

describe('getSelfCorrectionCleanupReadiness', () => {
  test.each(ALL_TIERS)(
    'is ready when the runtime and the selected model (%s) are installed',
    (tier) => {
      const readiness = getSelfCorrectionCleanupReadiness(
        { formatterModelTier: tier },
        availability([tier])
      )
      expect(readiness.ready).toBe(true)
      expect(readiness.reason).toBeNull()
    }
  )

  test.each(ALL_TIERS)(
    'the ready message names the model that will run (%s)',
    (tier) => {
      const readiness = getSelfCorrectionCleanupReadiness(
        { formatterModelTier: tier },
        availability([tier])
      )
      expect(readiness.message).toContain(FORMATTING_MODEL_LABELS[tier])
    }
  )

  test('with S1-mini the ready message says English only', () => {
    const readiness = getSelfCorrectionCleanupReadiness(
      { formatterModelTier: 's1-mini' },
      availability(['s1-mini'])
    )
    expect(readiness.ready).toBe(true)
    expect(readiness.message).toMatch(/english/i)
  })

  test.each(ALL_TIERS)(
    'is not ready without the llama.cpp runtime, even with %s installed',
    (tier) => {
      const readiness = getSelfCorrectionCleanupReadiness(
        { formatterModelTier: tier },
        availability(ALL_TIERS, false)
      )
      expect(readiness.ready).toBe(false)
      expect(readiness.reason).toBe('formatting_runtime_missing')
      expect(readiness.message.trim().length).toBeGreaterThan(0)
    }
  )

  test.each(ALL_TIERS)(
    'is not ready when the selected model (%s) is not installed but another is',
    (tier) => {
      const others = ALL_TIERS.filter((t) => t !== tier)
      const readiness = getSelfCorrectionCleanupReadiness(
        { formatterModelTier: tier },
        availability(others)
      )
      expect(readiness.ready).toBe(false)
      expect(readiness.reason).toBe('formatting_model_not_installed')
      expect(readiness.message).toContain(FORMATTING_MODEL_LABELS[tier])
    }
  )

  test('with no Formatting Model installed at all, the message says to download one', () => {
    const readiness = getSelfCorrectionCleanupReadiness(
      { formatterModelTier: 'fast' },
      availability([])
    )
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe('formatting_model_not_installed')
    expect(readiness.message).toMatch(/download/i)
  })

  test('only the selected model counts: a different installed model does not make it ready', () => {
    const readiness = getSelfCorrectionCleanupReadiness(
      { formatterModelTier: 'quality' },
      availability(['fast', 's1-mini'])
    )
    expect(readiness.ready).toBe(false)
  })

  test('readiness is plain serialisable data', () => {
    const readiness = getSelfCorrectionCleanupReadiness(
      { formatterModelTier: 'fast' },
      availability([])
    )
    expect(JSON.parse(JSON.stringify(readiness))).toEqual(readiness)
  })
})

describe('selfCorrectionCleanupHealMessage', () => {
  for (const tier of ALL_TIERS) {
    test.each(ALL_REASONS)(
      `names the selected model (${tier}) for reason %s`,
      (reason) => {
        const message = selfCorrectionCleanupHealMessage(
          { formatterModelTier: tier },
          reason
        )
        expect(message.trim().length).toBeGreaterThan(0)
        expect(message).toContain(FORMATTING_MODEL_LABELS[tier])
      }
    )
  }
})

describe('healSelfCorrectionCleanup', () => {
  test('switches the setting off and announces it when the selected model is removed', () => {
    const result = healSelfCorrectionCleanup(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 'quality' }),
      availability(['fast'])
    )
    expect(result.selfCorrectionCleanup).toBe(false)
    expect(result.healed).not.toBeNull()
    expect(result.healed?.reason).toBe('formatting_model_not_installed')
    expect(result.healed?.message).toContain(FORMATTING_MODEL_LABELS.quality)
  })

  test('switches the setting off and announces it when the runtime is missing', () => {
    const result = healSelfCorrectionCleanup(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 's1-mini' }),
      availability(ALL_TIERS, false)
    )
    expect(result.selfCorrectionCleanup).toBe(false)
    expect(result.healed?.reason).toBe('formatting_runtime_missing')
    expect(result.healed?.message).toContain(FORMATTING_MODEL_LABELS['s1-mini'])
  })

  test('the announcement matches selfCorrectionCleanupHealMessage', () => {
    const result = healSelfCorrectionCleanup(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 'fast' }),
      availability([])
    )
    expect(result.healed).not.toBeNull()
    expect(result.healed?.message).toBe(
      selfCorrectionCleanupHealMessage(
        { formatterModelTier: 'fast' },
        result.healed!.reason
      )
    )
  })

  test.each(ALL_TIERS)(
    'leaves an off setting off and announces nothing, even when unrunnable (%s)',
    (tier) => {
      const result = healSelfCorrectionCleanup(
        settings({ selfCorrectionCleanup: false, formatterModelTier: tier }),
        availability([], false)
      )
      expect(result).toEqual({ selfCorrectionCleanup: false, healed: null })
    }
  )

  test.each(ALL_TIERS)(
    'leaves an off setting off when it could run (%s)',
    (tier) => {
      const result = healSelfCorrectionCleanup(
        settings({ selfCorrectionCleanup: false, formatterModelTier: tier }),
        availability(ALL_TIERS)
      )
      expect(result).toEqual({ selfCorrectionCleanup: false, healed: null })
    }
  )

  test.each(ALL_TIERS)(
    'leaves an on setting on, unannounced, when it can run (%s)',
    (tier) => {
      const result = healSelfCorrectionCleanup(
        settings({ selfCorrectionCleanup: true, formatterModelTier: tier }),
        availability([tier])
      )
      expect(result).toEqual({ selfCorrectionCleanup: true, healed: null })
    }
  )
})

describe('applySelfCorrectionCleanupPatch', () => {
  test('refuses turning it on when the selected model is not installed', () => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 'quality' }),
      true,
      availability(['fast'])
    )
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'formatting_model_not_installed',
    })
  })

  test('refuses turning it on when the runtime is missing', () => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 'fast' }),
      true,
      availability(ALL_TIERS, false)
    )
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'formatting_runtime_missing',
    })
  })

  test.each(ALL_TIERS)('accepts turning it on while ready (%s)', (tier) => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: true, formatterModelTier: tier }),
      true,
      availability([tier])
    )
    expect(outcome).toEqual({
      kind: 'accepted',
      selfCorrectionCleanup: true,
      healed: null,
    })
  })

  test('turning it off is always allowed, even with nothing runnable', () => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: false, formatterModelTier: 's1-mini' }),
      false,
      availability([], false)
    )
    expect(outcome).toEqual({
      kind: 'accepted',
      selfCorrectionCleanup: false,
      healed: null,
    })
  })

  test('turning it off is allowed while ready', () => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: false, formatterModelTier: 'fast' }),
      false,
      availability(ALL_TIERS)
    )
    expect(outcome).toEqual({
      kind: 'accepted',
      selfCorrectionCleanup: false,
      healed: null,
    })
  })

  test('a write that selects an uninstalled model switches the on setting off and announces it', () => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 'quality' }),
      false,
      availability(['fast'])
    )
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') return
    expect(outcome.selfCorrectionCleanup).toBe(false)
    expect(outcome.healed?.reason).toBe('formatting_model_not_installed')
    expect(outcome.healed?.message).toContain(FORMATTING_MODEL_LABELS.quality)
  })

  test('an unrelated write leaves a runnable on setting alone', () => {
    const outcome = applySelfCorrectionCleanupPatch(
      settings({ selfCorrectionCleanup: true, formatterModelTier: 'fast' }),
      false,
      availability(['fast'])
    )
    expect(outcome).toEqual({
      kind: 'accepted',
      selfCorrectionCleanup: true,
      healed: null,
    })
  })
})

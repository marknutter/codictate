/**
 * The Scratch Command, exercised as a pure text transform: a transcript goes in, the
 * transcript with each "scratch that" and the phrase before it removed comes out. Written
 * against the spec in issue #12 and docs/adr/0008, not against the implementation.
 */

import { describe, expect, test } from 'bun:test'
import {
  applyScratchCommand,
  scratchCommandAppliesToLanguage,
} from './scratch-command'

describe('applyScratchCommand - removing the phrase before the command', () => {
  test('removes the unfinished phrase back to the previous sentence boundary', () => {
    expect(applyScratchCommand('Meet at three. Bring cake scratch that')).toBe(
      'Meet at three.'
    )
  })

  test('removes a finished sentence when the command follows its terminator', () => {
    expect(applyScratchCommand('Hello world. Bring cake. scratch that')).toBe(
      'Hello world.'
    )
  })

  test('treats ? and ! as sentence boundaries', () => {
    expect(applyScratchCommand('Are you there? Bring cake scratch that')).toBe(
      'Are you there?'
    )
    expect(applyScratchCommand('Wow! Bring cake scratch that')).toBe('Wow!')
  })

  test('a phrase with no earlier boundary is removed back to the start of the text', () => {
    expect(applyScratchCommand('Bring cake scratch that')).toBe('')
  })

  test('a dot not followed by whitespace is not a sentence boundary', () => {
    expect(applyScratchCommand('Hello. Version 1.5 is out scratch that')).toBe(
      'Hello.'
    )
  })
})

describe('applyScratchCommand - matching', () => {
  test('matches case-insensitively', () => {
    expect(
      applyScratchCommand('Hello. Wrong words SCRATCH THAT! Right words.')
    ).toBe('Hello. Right words.')
    expect(
      applyScratchCommand('Hello. Wrong words Scratch That right words.')
    ).toBe('Hello. right words.')
  })

  test('ignores punctuation around the command', () => {
    expect(
      applyScratchCommand('Hello. Bring cake, scratch that, bring pie.')
    ).toBe('Hello. bring pie.')
    expect(
      applyScratchCommand('Hello. Bring cake. Scratch that. Bring pie.')
    ).toBe('Hello. Bring pie.')
    expect(applyScratchCommand('Hello. Bring cake SCRATCH THAT!')).toBe(
      'Hello.'
    )
  })

  test('words that merely contain the phrase are untouched', () => {
    const inputs = [
      'Please scratchthat item.',
      'scratchthat',
      'The scratch thatch roof.',
      'scratch thatch',
      "Well, scratch that's fine.",
      "scratch that's fine",
      'An itchscratch that hurts.',
    ]
    for (const input of inputs) {
      expect(applyScratchCommand(input)).toBe(input)
    }
  })
})

describe('applyScratchCommand - repeated commands', () => {
  test('each command removes one more phrase', () => {
    expect(
      applyScratchCommand('One. Two. Three. scratch that scratch that')
    ).toBe('One.')
  })

  test('a later command stops at the point where the previous command cut', () => {
    expect(
      applyScratchCommand('One. Two scratch that three scratch that')
    ).toBe('One.')
  })

  test('commands beyond the available phrases leave nothing behind', () => {
    expect(
      applyScratchCommand('One. Two. scratch that scratch that scratch that')
    ).toBe('')
  })
})

describe('applyScratchCommand - command with nothing before it', () => {
  test('a leading command removes only itself', () => {
    expect(applyScratchCommand('Scratch that. Hello there.')).toBe(
      'Hello there.'
    )
  })

  test('the command alone yields an empty string', () => {
    expect(applyScratchCommand('scratch that')).toBe('')
    expect(applyScratchCommand('Scratch that.')).toBe('')
    expect(applyScratchCommand('  SCRATCH THAT!  ')).toBe('')
  })
})

describe('applyScratchCommand - text after the command', () => {
  test('keeps the text after the command with one space at the seam', () => {
    expect(
      applyScratchCommand('Meet at three. Bring cake scratch that bring pie.')
    ).toBe('Meet at three. bring pie.')
  })

  test('removes leading punctuation and whitespace after the command', () => {
    expect(
      applyScratchCommand(
        'Meet at three. Bring cake scratch that,   bring pie.'
      )
    ).toBe('Meet at three. bring pie.')
    expect(
      applyScratchCommand('Meet at three. Bring cake scratch that. Bring pie.')
    ).toBe('Meet at three. Bring pie.')
  })

  test('keeps the casing of the kept text as given', () => {
    expect(
      applyScratchCommand('Meet at three. Bring cake scratch that BRING PIE.')
    ).toBe('Meet at three. BRING PIE.')
  })

  test('result is trimmed', () => {
    expect(
      applyScratchCommand('  Meet at three. Bring cake scratch that  ')
    ).toBe('Meet at three.')
  })
})

describe('applyScratchCommand - unchanged and stable output', () => {
  test('text without the phrase is returned exactly unchanged', () => {
    const inputs = [
      '',
      'Hello world.',
      '  Hello   world.  Two  spaces  ',
      'Scratch the surface.',
      'That scratch is deep.',
      'Line one.\nLine two.',
    ]
    for (const input of inputs) {
      expect(applyScratchCommand(input)).toBe(input)
    }
  })

  test('is idempotent', () => {
    const inputs = [
      'Meet at three. Bring cake scratch that',
      'Hello world. Bring cake. scratch that',
      'One. Two. Three. scratch that scratch that',
      'Scratch that. Hello there.',
      'scratch that',
      'Meet at three. Bring cake scratch that bring pie.',
      'Hello. Bring cake, scratch that, bring pie.',
      'One. Two scratch that three scratch that',
      "Well, scratch that's fine.",
    ]
    for (const input of inputs) {
      const once = applyScratchCommand(input)
      expect(applyScratchCommand(once)).toBe(once)
    }
  })

  test('never leaves double spaces at a seam', () => {
    const inputs = [
      'Meet at three. Bring cake scratch that bring pie.',
      'Meet at three.  Bring cake  scratch that  bring pie.',
      'Hello. Bring cake, scratch that, bring pie.',
      'One. Two scratch that three scratch that four.',
      'Scratch that.  Hello there.',
      'Hello. Wrong words SCRATCH THAT! Right words.',
    ]
    for (const input of inputs) {
      expect(applyScratchCommand(input)).not.toContain('  ')
    }
  })
})

describe('scratchCommandAppliesToLanguage', () => {
  test('applies to English and auto-detect', () => {
    expect(scratchCommandAppliesToLanguage('en')).toBe(true)
    expect(scratchCommandAppliesToLanguage('auto')).toBe(true)
  })

  test('does not apply to other languages', () => {
    for (const id of ['da', 'de', 'fr', 'es', 'sv', 'nl', 'ja']) {
      expect(scratchCommandAppliesToLanguage(id)).toBe(false)
    }
  })
})

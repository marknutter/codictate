/**
 * What the Staging Overlay shows for a running Live Transcription, checked against
 * GitHub issues #11 / #12 and ADR-0008: the overlay draws `committed + partial`
 * verbatim, the Scratch Command is applied only for eligible Transcription
 * Languages, the committed/partial split never splits a word, and only the tail
 * that fits is kept. Pure functions only: no subprocess, filesystem or webview.
 */

import { describe, expect, test } from 'bun:test'
import {
  shapeStagingOverlayText,
  stagingOverlayTextEquals,
  stagingOverlayTextIsEmpty,
  type LiveTranscriptUpdate,
  type StagingOverlayText,
} from './staging-overlay-text'

const ELLIPSIS = '…'

function update(
  text: string,
  committedText = '',
  transcriptionLanguageId = 'en'
): LiveTranscriptUpdate {
  return { text, committedText, transcriptionLanguageId }
}

function drawn(result: StagingOverlayText): string {
  return result.committed + result.partial
}

describe('shapeStagingOverlayText', () => {
  describe('empty input', () => {
    test('empty text gives both parts empty', () => {
      const result = shapeStagingOverlayText(update(''))
      expect(result).toEqual({ committed: '', partial: '' })
      expect(stagingOverlayTextIsEmpty(result)).toBe(true)
    })

    test('whitespace-only text gives both parts empty', () => {
      const result = shapeStagingOverlayText(update('   \t  ', '  '))
      expect(result).toEqual({ committed: '', partial: '' })
      expect(stagingOverlayTextIsEmpty(result)).toBe(true)
    })

    test('text that is only a Scratch Command is empty in English', () => {
      const result = shapeStagingOverlayText(update('scratch that'))
      expect(stagingOverlayTextIsEmpty(result)).toBe(true)
    })
  })

  describe('committed + partial is the displayed text', () => {
    test('partial carries its own leading space after committed text', () => {
      const result = shapeStagingOverlayText(
        update('Hello world. How are', 'Hello world.')
      )
      expect(result).toEqual({ committed: 'Hello world.', partial: ' How are' })
      expect(drawn(result)).toBe('Hello world. How are')
    })

    test('no double spaces where committed and partial meet', () => {
      const result = shapeStagingOverlayText(
        update('One two three four', 'One two')
      )
      expect(drawn(result)).toBe('One two three four')
      expect(drawn(result)).not.toContain('  ')
    })

    test('all-partial text has no leading space', () => {
      const result = shapeStagingOverlayText(update('Just started', ''))
      expect(result.committed).toBe('')
      expect(result.partial).toBe('Just started')
    })

    test('fully committed text has an empty partial', () => {
      const result = shapeStagingOverlayText(
        update('All done here.', 'All done here.')
      )
      expect(result).toEqual({ committed: 'All done here.', partial: '' })
    })

    test('result is trimmed at both ends', () => {
      const result = shapeStagingOverlayText(
        update('  Hello world. How are  ', '  Hello world.')
      )
      expect(drawn(result)).toBe('Hello world. How are')
      expect(result.committed.startsWith(' ')).toBe(false)
      expect(drawn(result).endsWith(' ')).toBe(false)
    })
  })

  describe('committed/partial split', () => {
    test('a split that would land inside a word moves back to the word start', () => {
      // Shared prefix of "Hello wor" and "Hello world" ends mid-word.
      const result = shapeStagingOverlayText(update('Hello world', 'Hello wor'))
      expect(drawn(result)).toBe('Hello world')
      expect(result.committed).toBe('Hello')
      expect(result.partial).toBe(' world')
    })

    test('committed is never longer than the committed text when nothing is revised', () => {
      const committedText = 'The quick brown'
      const result = shapeStagingOverlayText(
        update('The quick brown fox jumps', committedText)
      )
      expect(result.committed.length).toBeLessThanOrEqual(committedText.length)
      expect(result.committed).toBe('The quick brown')
      expect(result.partial).toBe(' fox jumps')
    })

    test('no word is split between committed and partial', () => {
      const cases: Array<[string, string]> = [
        ['Alpha beta gamma delta', 'Alpha be'],
        ['Alpha beta gamma delta', 'Alpha beta g'],
        ['Alpha beta gamma delta', 'Alph'],
      ]
      for (const [text, committedText] of cases) {
        const result = shapeStagingOverlayText(update(text, committedText))
        expect(drawn(result)).toBe(text)
        if (result.committed !== '' && result.partial !== '') {
          // Either the committed side ends at a boundary or the partial starts with one.
          const endsAtBoundary = /\s$/.test(result.committed)
          const startsAtBoundary = /^\s/.test(result.partial)
          expect(endsAtBoundary || startsAtBoundary).toBe(true)
        }
      }
    })

    test('a Scratch Command in the partial that removes committed words', () => {
      const result = shapeStagingOverlayText(
        update(
          'Meet at three. Bring cake scratch that',
          'Meet at three. Bring cake'
        )
      )
      expect(drawn(result)).toBe('Meet at three.')
      expect(result.committed.length).toBeLessThanOrEqual(
        'Meet at three.'.length
      )
      expect(drawn(result)).not.toContain('  ')
    })
  })

  describe('Scratch Command', () => {
    const text = 'Meet at three. Bring cake scratch that'

    test("is applied for 'en'", () => {
      expect(drawn(shapeStagingOverlayText(update(text, '', 'en')))).toBe(
        'Meet at three.'
      )
    })

    test("is applied for 'auto'", () => {
      expect(drawn(shapeStagingOverlayText(update(text, '', 'auto')))).toBe(
        'Meet at three.'
      )
    })

    test("is not applied for 'da'", () => {
      expect(drawn(shapeStagingOverlayText(update(text, '', 'da')))).toBe(text)
    })

    test('is case-insensitive', () => {
      expect(
        drawn(
          shapeStagingOverlayText(
            update('Meet at three. Bring cake Scratch That', '', 'en')
          )
        )
      ).toBe('Meet at three.')
    })

    test('matches whole words only', () => {
      const notACommand = 'Meet at three. Bring cake scratchthat'
      expect(
        drawn(shapeStagingOverlayText(update(notACommand, '', 'en')))
      ).toBe(notACommand)
    })

    test('committed text is scratched the same way as the whole text', () => {
      const result = shapeStagingOverlayText(
        update(
          'Meet at three. Bring cake scratch that Bring pie',
          'Meet at three. Bring cake scratch that',
          'en'
        )
      )
      expect(drawn(result)).toBe('Meet at three. Bring pie')
      expect(result.committed).toBe('Meet at three.')
      expect(result.partial).toBe(' Bring pie')
    })
  })

  describe('tail truncation', () => {
    test('short text has no ellipsis', () => {
      const result = shapeStagingOverlayText(update('Short text here', ''), 240)
      expect(drawn(result)).toBe('Short text here')
      expect(drawn(result)).not.toContain(ELLIPSIS)
    })

    test('text exactly maxChars long is not cut', () => {
      const text = 'abcd efgh ij' // 12 chars
      const result = shapeStagingOverlayText(update(text, ''), 12)
      expect(drawn(result)).toBe(text)
    })

    test('long text keeps the tail, prefixed with an ellipsis, cut at a word boundary', () => {
      const words = Array.from({ length: 30 }, (_, i) => `word${i}`)
      const text = words.join(' ')
      const maxChars = 40
      const result = shapeStagingOverlayText(update(text, ''), maxChars)
      const shown = drawn(result)

      expect(shown.startsWith(ELLIPSIS)).toBe(true)
      const tail = shown.slice(ELLIPSIS.length)
      expect(tail.length).toBeLessThanOrEqual(maxChars)
      expect(text.endsWith(tail)).toBe(true)
      // The first visible word is whole.
      const firstWord = tail.trimStart().split(' ')[0]
      expect(words).toContain(firstWord)
      expect(shown.length).toBeLessThanOrEqual(maxChars + ELLIPSIS.length)
    })

    test('uses the default maxChars of 240', () => {
      const words = Array.from({ length: 100 }, (_, i) => `w${i}`)
      const text = words.join(' ')
      expect(text.length).toBeGreaterThan(240)
      const shown = drawn(shapeStagingOverlayText(update(text, '')))
      expect(shown.startsWith(ELLIPSIS)).toBe(true)
      const tail = shown.slice(ELLIPSIS.length)
      expect(tail.length).toBeLessThanOrEqual(240)
      expect(text.endsWith(tail)).toBe(true)
      expect(words).toContain(tail.trimStart().split(' ')[0])
    })

    test('truncation keeps the committed/partial split consistent', () => {
      const committedWords = Array.from({ length: 20 }, (_, i) => `com${i}`)
      const partialWords = ['part0', 'part1']
      const committedText = committedWords.join(' ')
      const text = `${committedText} ${partialWords.join(' ')}`
      const result = shapeStagingOverlayText(update(text, committedText), 40)

      expect(result.partial).toBe(' part0 part1')
      expect(result.committed.startsWith(ELLIPSIS)).toBe(true)
      expect(
        committedText.endsWith(result.committed.slice(ELLIPSIS.length))
      ).toBe(true)
    })

    test('when only partial survives, the ellipsis goes with the partial', () => {
      const committedText = 'Committed words.'
      const partial = Array.from({ length: 20 }, (_, i) => `p${i}`).join(' ')
      const text = `${committedText} ${partial}`
      const result = shapeStagingOverlayText(update(text, committedText), 30)
      expect(result.committed).toBe('')
      expect(result.partial.startsWith(ELLIPSIS)).toBe(true)
      expect(text.endsWith(result.partial.slice(ELLIPSIS.length))).toBe(true)
    })
  })
})

describe('stagingOverlayTextEquals', () => {
  test('is true for identical results', () => {
    expect(
      stagingOverlayTextEquals(
        { committed: 'a', partial: ' b' },
        { committed: 'a', partial: ' b' }
      )
    ).toBe(true)
  })

  test('is true for two shapes of the same update', () => {
    const u = update('Hello world. How are', 'Hello world.')
    expect(
      stagingOverlayTextEquals(
        shapeStagingOverlayText(u),
        shapeStagingOverlayText(u)
      )
    ).toBe(true)
  })

  test('is false when committed differs', () => {
    expect(
      stagingOverlayTextEquals(
        { committed: 'a', partial: ' b' },
        { committed: 'x', partial: ' b' }
      )
    ).toBe(false)
  })

  test('is false when partial differs', () => {
    expect(
      stagingOverlayTextEquals(
        { committed: 'a', partial: ' b' },
        { committed: 'a', partial: ' c' }
      )
    ).toBe(false)
  })

  test('is false when the same drawn text is split differently', () => {
    expect(
      stagingOverlayTextEquals(
        { committed: 'a b', partial: '' },
        { committed: 'a', partial: ' b' }
      )
    ).toBe(false)
  })
})

describe('stagingOverlayTextIsEmpty', () => {
  test('is true when both parts are empty', () => {
    expect(stagingOverlayTextIsEmpty({ committed: '', partial: '' })).toBe(true)
  })

  test('is false with committed text only', () => {
    expect(stagingOverlayTextIsEmpty({ committed: 'a', partial: '' })).toBe(
      false
    )
  })

  test('is false with partial text only', () => {
    expect(stagingOverlayTextIsEmpty({ committed: '', partial: 'a' })).toBe(
      false
    )
  })
})

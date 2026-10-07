import { describe, expect, test } from 'bun:test'
import {
  encodeParakeetStreamEvent,
  LiveTranscript,
  parseParakeetStreamEvent,
  type ParakeetStreamEvent,
} from './parakeet-stream-protocol'

const partial = (text: string): ParakeetStreamEvent => ({
  kind: 'partial',
  text,
})
const commit = (text: string): ParakeetStreamEvent => ({ kind: 'commit', text })
const final: ParakeetStreamEvent = { kind: 'final' }

describe('Parakeet stream protocol encoding', () => {
  const events: ParakeetStreamEvent[] = [
    partial('hel'),
    partial(''),
    commit('Hello.'),
    commit(''),
    commit('æble "quoted"\nwith newline'),
    final,
  ]

  for (const event of events) {
    test(`encodes ${JSON.stringify(event)} as one line that round-trips`, () => {
      const line = encodeParakeetStreamEvent(event)
      expect(line).not.toContain('\n')
      expect(line).not.toContain('\r')
      expect(parseParakeetStreamEvent(line)).toEqual(event)
    })
  }

  test('encodes valid JSON carrying the kind discriminator', () => {
    expect(JSON.parse(encodeParakeetStreamEvent(partial('hi')))).toEqual({
      kind: 'partial',
      text: 'hi',
    })
    expect(JSON.parse(encodeParakeetStreamEvent(final))).toEqual({
      kind: 'final',
    })
  })
})

describe('Parakeet stream protocol parsing', () => {
  test('parses each event kind from an exact line', () => {
    expect(parseParakeetStreamEvent('{"kind":"partial","text":"hel"}')).toEqual(
      partial('hel')
    )
    expect(
      parseParakeetStreamEvent('{"kind":"commit","text":"Hello."}')
    ).toEqual(commit('Hello.'))
    expect(parseParakeetStreamEvent('{"kind":"commit","text":""}')).toEqual(
      commit('')
    )
    expect(parseParakeetStreamEvent('{"kind":"final"}')).toEqual(final)
  })

  const malformed: [string, string][] = [
    ['empty line', ''],
    ['invalid JSON', '{"kind":"partial","text":'],
    ['plain text', 'hello world'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON string', '"partial"'],
    ['JSON boolean', 'true'],
    ['an array', '[{"kind":"final"}]'],
    ['an empty array', '[]'],
    ['an empty object', '{}'],
    ['unknown kind', '{"kind":"ready"}'],
    ['non-string kind', '{"kind":1,"text":"x"}'],
    ['wrong-case kind', '{"kind":"Partial","text":"x"}'],
    ['partial without text', '{"kind":"partial"}'],
    ['commit without text', '{"kind":"commit"}'],
    ['partial with numeric text', '{"kind":"partial","text":5}'],
    ['commit with null text', '{"kind":"commit","text":null}'],
    ['commit with array text', '{"kind":"commit","text":["a"]}'],
    ['partial with object text', '{"kind":"partial","text":{"a":1}}'],
  ]

  for (const [label, line] of malformed) {
    test(`returns null for ${label}`, () => {
      expect(parseParakeetStreamEvent(line)).toBeNull()
    })
  }
})

describe('LiveTranscript', () => {
  test('a fresh transcript is empty', () => {
    const transcript = new LiveTranscript()
    expect(transcript.text()).toBe('')
    expect(transcript.finalText()).toBe('')
  })

  test('the spec sequence builds committed text plus the current partial', () => {
    const transcript = new LiveTranscript()
    expect(transcript.apply(partial('hel'))).toBe(true)
    expect(transcript.text()).toBe('hel')
    expect(transcript.apply(partial('hello'))).toBe(true)
    expect(transcript.text()).toBe('hello')
    expect(transcript.apply(commit('Hello.'))).toBe(true)
    expect(transcript.text()).toBe('Hello.')
    expect(transcript.apply(partial('how'))).toBe(true)
    expect(transcript.text()).toBe('Hello. how')
    expect(transcript.finalText()).toBe('Hello. how')
  })

  test('a partial replaces the previous partial rather than appending', () => {
    const transcript = new LiveTranscript()
    transcript.apply(partial('one'))
    transcript.apply(partial('two'))
    expect(transcript.text()).toBe('two')
  })

  test('a commit after a partial replaces it without duplicating', () => {
    const transcript = new LiveTranscript()
    transcript.apply(partial('hello there'))
    transcript.apply(commit('Hello there.'))
    expect(transcript.text()).toBe('Hello there.')
    expect(transcript.finalText()).toBe('Hello there.')
  })

  test('multiple commits join with single spaces', () => {
    const transcript = new LiveTranscript()
    transcript.apply(commit('One.'))
    transcript.apply(commit('Two.'))
    transcript.apply(commit('Three.'))
    expect(transcript.text()).toBe('One. Two. Three.')
    expect(transcript.finalText()).toBe('One. Two. Three.')
  })

  test('applying the same partial twice reports no change the second time', () => {
    const transcript = new LiveTranscript()
    expect(transcript.apply(partial('same'))).toBe(true)
    expect(transcript.apply(partial('same'))).toBe(false)
    expect(transcript.text()).toBe('same')
  })

  test('final does not change the text', () => {
    const transcript = new LiveTranscript()
    transcript.apply(commit('Done.'))
    transcript.apply(partial('trailing'))
    expect(transcript.apply(final)).toBe(false)
    expect(transcript.text()).toBe('Done. trailing')
    expect(transcript.finalText()).toBe('Done. trailing')
  })

  test('final on a fresh transcript changes nothing', () => {
    const transcript = new LiveTranscript()
    expect(transcript.apply(final)).toBe(false)
    expect(transcript.text()).toBe('')
    expect(transcript.finalText()).toBe('')
  })

  test('an empty commit with a partial clears the partial and reports a change', () => {
    const transcript = new LiveTranscript()
    transcript.apply(commit('Kept.'))
    transcript.apply(partial('uh'))
    expect(transcript.apply(commit(''))).toBe(true)
    expect(transcript.text()).toBe('Kept.')
    expect(transcript.finalText()).toBe('Kept.')
  })

  test('an empty commit with no partial reports no change', () => {
    const transcript = new LiveTranscript()
    expect(transcript.apply(commit(''))).toBe(false)
    expect(transcript.text()).toBe('')
    transcript.apply(commit('Kept.'))
    expect(transcript.apply(commit(''))).toBe(false)
    expect(transcript.text()).toBe('Kept.')
  })

  test('an empty commit adds no segment, so no double space appears', () => {
    const transcript = new LiveTranscript()
    transcript.apply(commit('A.'))
    transcript.apply(partial('x'))
    transcript.apply(commit(''))
    transcript.apply(commit('B.'))
    expect(transcript.text()).toBe('A. B.')
  })

  test('a trailing partial reaches finalText', () => {
    const transcript = new LiveTranscript()
    transcript.apply(partial('never committed'))
    expect(transcript.finalText()).toBe('never committed')
  })

  test('output never has leading, trailing or doubled spaces', () => {
    const transcript = new LiveTranscript()
    const sequence: ParakeetStreamEvent[] = [
      partial(''),
      commit(' First. '),
      partial(' second  part '),
      commit('Second  part.'),
      partial(''),
      commit(''),
      partial(' third '),
    ]
    for (const event of sequence) {
      transcript.apply(event)
      for (const output of [transcript.text(), transcript.finalText()]) {
        expect(output).toBe(output.trim())
        expect(output).not.toContain('  ')
      }
    }
  })

  test('an empty partial after a commit leaves no trailing space', () => {
    const transcript = new LiveTranscript()
    transcript.apply(commit('Hello.'))
    transcript.apply(partial(''))
    expect(transcript.text()).toBe('Hello.')
    expect(transcript.finalText()).toBe('Hello.')
  })
})

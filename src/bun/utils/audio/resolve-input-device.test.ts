/**
 * `resolveInputDevice` turns the user's saved microphone choice into the device the
 * recorder should open right now, or `missing`. It never substitutes: a chosen microphone
 * that is gone does not fall back to its old index or to the first device.
 */

import { describe, expect, test } from 'bun:test'
import type { AudioDeviceDetails } from '../../../shared/types'
import { resolveInputDevice } from './resolve-input-device'

const macList = {
  devices: { '0': 'MacBook Pro Microphone', '1': 'AirPods Pro', '2': 'Shure MV7' },
  details: {} as Record<string, AudioDeviceDetails>,
}

function winList(entries: Array<[string, string, string | null]>) {
  const devices: Record<string, string> = {}
  const details: Record<string, AudioDeviceDetails> = {}
  for (const [key, name, id] of entries) {
    devices[key] = name
    details[key] = { index: Number(key), name, id }
  }
  return { devices, details }
}

const WIN_A = '{0.0.1.00000000}.{aaaa}'
const WIN_B = '{0.0.1.00000000}.{bbbb}'
const WIN_C = '{0.0.1.00000000}.{cccc}'

describe('resolveInputDevice — macOS-shaped input (no endpoint ids)', () => {
  test('resolves a chosen microphone by exact name', () => {
    expect(
      resolveInputDevice({ id: null, name: 'AirPods Pro', index: 1 }, macList)
    ).toEqual({
      status: 'found',
      index: 1,
      label: 'AirPods Pro',
      endpointId: null,
      deviceRef: '1',
    })
  })

  test('reordered indices: chosen mic resolves to its new index by name', () => {
    expect(
      resolveInputDevice({ id: null, name: 'Shure MV7', index: 0 }, macList)
    ).toEqual({
      status: 'found',
      index: 2,
      label: 'Shure MV7',
      endpointId: null,
      deviceRef: '2',
    })
  })

  test('disconnected chosen mic is missing, not its saved index', () => {
    // Saved index 1 still exists (now a different device) - must not be used.
    expect(
      resolveInputDevice({ id: null, name: 'Yeti', index: 1 }, macList)
    ).toEqual({ status: 'missing' })
  })

  test('disconnected chosen mic is missing, not the first device', () => {
    expect(
      resolveInputDevice({ id: null, name: 'Yeti', index: 99 }, macList)
    ).toEqual({ status: 'missing' })
  })

  test('name matching is case-sensitive', () => {
    expect(
      resolveInputDevice({ id: null, name: 'airpods pro', index: 7 }, macList)
    ).toEqual({ status: 'missing' })
  })

  test('name matching is not partial', () => {
    expect(
      resolveInputDevice({ id: null, name: 'AirPods', index: 7 }, macList)
    ).toEqual({ status: 'missing' })
    expect(
      resolveInputDevice({ id: null, name: 'AirPods Pro 2', index: 7 }, macList)
    ).toEqual({ status: 'missing' })
  })
})

describe('resolveInputDevice — Windows-shaped input (endpoint ids)', () => {
  const list = winList([
    ['0', 'Microphone (Realtek Audio)', WIN_A],
    ['1', 'Headset (Jabra)', WIN_B],
    ['3', 'USB Mic', WIN_C],
  ])

  test('resolves by endpoint id; deviceRef is the id', () => {
    expect(
      resolveInputDevice({ id: WIN_B, name: 'Headset (Jabra)', index: 1 }, list)
    ).toEqual({
      status: 'found',
      index: 1,
      label: 'Headset (Jabra)',
      endpointId: WIN_B,
      deviceRef: WIN_B,
    })
  })

  test('reordered indices: chosen mic resolves to its new index by id', () => {
    expect(
      resolveInputDevice({ id: WIN_C, name: 'USB Mic', index: 0 }, list)
    ).toEqual({
      status: 'found',
      index: 3,
      label: 'USB Mic',
      endpointId: WIN_C,
      deviceRef: WIN_C,
    })
  })

  test('id match wins over a name match pointing at a different device', () => {
    const r = resolveInputDevice({ id: WIN_A, name: 'USB Mic', index: 3 }, list)
    expect(r).toEqual({
      status: 'found',
      index: 0,
      label: 'Microphone (Realtek Audio)',
      endpointId: WIN_A,
      deviceRef: WIN_A,
    })
  })

  test('falls back to name when the id is not present', () => {
    expect(
      resolveInputDevice({ id: '{gone}', name: 'USB Mic', index: 0 }, list)
    ).toEqual({
      status: 'found',
      index: 3,
      label: 'USB Mic',
      endpointId: WIN_C,
      deviceRef: WIN_C,
    })
  })

  test('id present in details but not in devices does not match', () => {
    const skewed = {
      devices: { '0': 'Microphone (Realtek Audio)' },
      details: {
        '0': { index: 0, name: 'Microphone (Realtek Audio)', id: WIN_A },
        '5': { index: 5, name: 'Ghost', id: WIN_B },
      },
    }
    expect(
      resolveInputDevice({ id: WIN_B, name: 'Ghost', index: 5 }, skewed)
    ).toEqual({ status: 'missing' })
  })

  test('disconnected chosen mic is missing even though other mics and its index exist', () => {
    expect(
      resolveInputDevice({ id: '{gone}', name: 'Blue Yeti', index: 1 }, list)
    ).toEqual({ status: 'missing' })
  })

  test('chosen by id only, id gone: missing (no index fallback)', () => {
    expect(
      resolveInputDevice({ id: '{gone}', name: null, index: 0 }, list)
    ).toEqual({ status: 'missing' })
  })

  test('matched device with null endpoint id uses the index as deviceRef', () => {
    const mixed = winList([
      ['0', 'Microphone (Realtek Audio)', WIN_A],
      ['2', 'Legacy Mic', null],
    ])
    expect(
      resolveInputDevice({ id: null, name: 'Legacy Mic', index: 0 }, mixed)
    ).toEqual({
      status: 'found',
      index: 2,
      label: 'Legacy Mic',
      endpointId: null,
      deviceRef: '2',
    })
  })
})

describe('resolveInputDevice — no microphone chosen (id and name both null)', () => {
  test('resolves by index when that key exists', () => {
    expect(
      resolveInputDevice({ id: null, name: null, index: 2 }, macList)
    ).toEqual({
      status: 'found',
      index: 2,
      label: 'Shure MV7',
      endpointId: null,
      deviceRef: '2',
    })
  })

  test('index resolution on Windows carries the endpoint id', () => {
    const list = winList([['4', 'USB Mic', WIN_C]])
    expect(resolveInputDevice({ id: null, name: null, index: 4 }, list)).toEqual({
      status: 'found',
      index: 4,
      label: 'USB Mic',
      endpointId: WIN_C,
      deviceRef: WIN_C,
    })
  })

  test('missing when the index is not in the list', () => {
    expect(
      resolveInputDevice({ id: null, name: null, index: 9 }, macList)
    ).toEqual({ status: 'missing' })
  })
})

describe('resolveInputDevice — empty device list', () => {
  const empty = { devices: {}, details: {} }
  test.each([
    { id: null, name: null, index: 0 },
    { id: null, name: 'AirPods Pro', index: 0 },
    { id: WIN_A, name: 'USB Mic', index: 0 },
    { id: WIN_A, name: null, index: 0 },
  ])('missing for selection %o', (selection) => {
    expect(resolveInputDevice(selection, empty)).toEqual({ status: 'missing' })
  })
})

describe('resolveInputDevice — label', () => {
  test('trims whitespace around the device name', () => {
    const list = { devices: { '0': '  Shure MV7 \t' }, details: {} }
    const r = resolveInputDevice({ id: null, name: null, index: 0 }, list)
    expect(r).toEqual({
      status: 'found',
      index: 0,
      label: 'Shure MV7',
      endpointId: null,
      deviceRef: '0',
    })
  })

  test('empty name labels as "default"', () => {
    const list = { devices: { '0': '' }, details: {} }
    const r = resolveInputDevice({ id: null, name: null, index: 0 }, list)
    expect(r.status).toBe('found')
    if (r.status === 'found') expect(r.label).toBe('default')
  })

  test('whitespace-only name labels as "default"', () => {
    const list = winList([['1', '   ', WIN_A]])
    const r = resolveInputDevice({ id: WIN_A, name: null, index: 0 }, list)
    expect(r).toEqual({
      status: 'found',
      index: 1,
      label: 'default',
      endpointId: WIN_A,
      deviceRef: WIN_A,
    })
  })
})

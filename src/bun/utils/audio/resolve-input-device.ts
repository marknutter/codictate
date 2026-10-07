import type { AudioDeviceDetails } from '../../../shared/types'

/** The microphone the user chose, as persisted: a stable endpoint id (Windows), a name, an index. */
export interface InputDeviceSelection {
  id: string | null
  name: string | null
  index: number
}

/** The current device list: index (as a string key) to name, plus per-index details. */
export interface InputDeviceList {
  devices: Record<string, string>
  details: Record<string, AudioDeviceDetails>
}

export type ResolvedInputDevice =
  | {
      status: 'found'
      index: number
      label: string
      endpointId: string | null
      /** What the recorder and the Parakeet helper take: the endpoint id when known, else the index. */
      deviceRef: string
    }
  | { status: 'missing' }

/**
 * Which microphone a Dictation records from, for Batch Dictation and Live Transcription alike.
 *
 * A chosen microphone is matched by its stable id, then by its name. When the user chose one
 * and it is not in the list, the answer is `missing`: never the saved index, which by then can
 * point at a different device, and never the first device in the list. ADR-0005 - a Dictation
 * does not adapt to an unrunnable state, it is blocked with a reason. Only a configuration
 * with no id and no name (nothing ever chosen) resolves by index.
 */
export function resolveInputDevice(
  selection: InputDeviceSelection,
  list: InputDeviceList
): ResolvedInputDevice {
  const found = (key: string): ResolvedInputDevice => {
    const endpointId = list.details[key]?.id ?? null
    return {
      status: 'found',
      index: Number(key),
      label: list.devices[key]?.trim() || 'default',
      endpointId,
      deviceRef: endpointId ?? key,
    }
  }

  if (selection.id !== null) {
    const byId = Object.entries(list.details).find(
      ([key, device]) => device.id === selection.id && key in list.devices
    )
    if (byId) return found(byId[0])
  }
  if (selection.name !== null) {
    const byName = Object.entries(list.devices).find(
      ([, name]) => name === selection.name
    )
    if (byName) return found(byName[0])
  }
  if (selection.id !== null || selection.name !== null)
    return { status: 'missing' }

  const key = String(selection.index)
  return key in list.devices ? found(key) : { status: 'missing' }
}

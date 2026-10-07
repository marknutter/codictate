// Small models behave better when the schema is tiny and the field semantics
// are blunt. Keep fields short, mandatory, and mutually exclusive.

export interface FormattedEmail {
  language: string
  greeting: string
  body: string
  closing: string
}

export interface FormattedIMessage {
  message: string
}

export interface FormattedSlack {
  message: string
}

export interface FormattedDocument {
  title: string
  body: string
}

export const emailSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: {
      type: 'string',
      description: 'ISO 639-1 language code for the final email text.',
    },
    greeting: {
      type: 'string',
      description: 'Greeting only. Empty string if no greeting.',
    },
    body: {
      type: 'string',
      description:
        'Email body only, as finished written prose with correct capitalization and punctuation. No greeting. No closing. No sender name.',
    },
    closing: {
      type: 'string',
      description:
        'Sign-off only. Empty string if no sign-off. No sender name.',
    },
  },
  required: ['language', 'greeting', 'body', 'closing'],
} as const

export const imessageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        'Single finished text message with corrected capitalization and punctuation.',
    },
  },
  required: ['message'],
} as const

export const slackSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        'Single finished Slack message with corrected capitalization and punctuation.',
    },
  },
  required: ['message'],
} as const

export const documentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'Optional document title. Empty string if none.',
    },
    body: {
      type: 'string',
      description:
        'Document body only, as finished written text with corrected capitalization and punctuation.',
    },
  },
  required: ['title', 'body'],
} as const

/** Self-correction Cleanup's result: the same text, with spoken corrections resolved. */
export interface SelfCorrectedText {
  text: string
}

export const selfCorrectionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description:
        'The transcript with spoken self-corrections resolved and every other word unchanged.',
    },
  },
  required: ['text'],
} as const

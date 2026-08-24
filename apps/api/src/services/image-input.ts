/**
 * What counts as a photograph a user may send us.
 *
 * The routes accepted any string and described it as "data: URI or https URL".
 * We never fetch it ourselves — it goes to the Router as an `image_url` content
 * part — but the provider on the other end does fetch it, using our account.
 *
 * That made an arbitrary URL from any signed-in person into a request issued by
 * our infrastructure to wherever they chose: a way to probe networks under our
 * identity and bill it to us, and a way to point at a very large remote image
 * whose cost we would discover afterwards.
 *
 * No legitimate client ever did this. The app captures a photo with
 * `readAsDataURL` and posts the result, so accepting remote URLs bought nothing
 * and carried both risks. This narrows the input to exactly what the product
 * sends.
 */

import { z } from 'zod'

/** Formats a camera or gallery realistically produces, and models accept. */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']

/**
 * Ceiling on the encoded string.
 *
 * The body limit already caps the request, but failing here says *which* field
 * was too big and why, rather than dropping the connection with a bare 413.
 * Base64 inflates by about a third, so this is roughly a six-megabyte photo.
 */
export const MAX_IMAGE_DATA_URL_CHARS = 8_000_000

export interface ImageInputProblem {
  ok: false
  reason: string
}

export type ImageInputResult = { ok: true; mediaType: string } | ImageInputProblem

/**
 * Check a data URL without decoding it.
 *
 * Deliberately does not parse the base64 payload. Decoding several megabytes to
 * validate it would cost more than the check is worth, and the model rejects a
 * malformed image anyway — the job here is to refuse the *shape* we never meant
 * to accept.
 */
export function checkImageDataUrl(value: string): ImageInputResult {
  if (value.length > MAX_IMAGE_DATA_URL_CHARS) {
    return { ok: false, reason: 'that photo is too large' }
  }

  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match) {
    // Named plainly, because the most likely cause is a client sending a remote
    // URL and the least likely is somebody probing.
    return {
      ok: false,
      reason: 'photos must be sent as base64 data, not as a link to somewhere else',
    }
  }

  const mediaType = match[1]!
  if (!ALLOWED_TYPES.includes(mediaType)) {
    return { ok: false, reason: `${mediaType} is not an image format we accept` }
  }

  if (match[2]!.length < 32) {
    return { ok: false, reason: 'that does not look like a photo' }
  }

  return { ok: true, mediaType }
}

/** Zod schema for a field that must be an inline image. */
export const ImageDataUrl = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const result = checkImageDataUrl(value)
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason })
    }
  })

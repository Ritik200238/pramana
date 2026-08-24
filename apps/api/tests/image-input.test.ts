/**
 * What may be sent as a photograph.
 *
 * The routes took any string, described as "data: URI or https URL". We never
 * fetch it — it goes to the Router as an image_url content part — but the
 * provider on the other end does, on our account. So any signed-in person could
 * make our infrastructure issue a request to an address of their choosing, and
 * point us at a remote image whose cost we would find out about later.
 *
 * No client ever did this: the app captures with readAsDataURL and posts the
 * result. The remote-URL case bought nothing and carried both risks.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_IMAGE_DATA_URL_CHARS, checkImageDataUrl } from '../src/services/image-input.ts'

/** A small but structurally valid inline image. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a photo from the app is accepted', () => {
  const result = checkImageDataUrl(PIXEL)
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.mediaType, 'image/png')
})

test('every format a phone camera produces is accepted', () => {
  const body = PIXEL.slice(PIXEL.indexOf(',') + 1)
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    const result = checkImageDataUrl(`data:${type};base64,${body}`)
    assert.equal(result.ok, true, `${type} should be accepted`)
  }
})

test('a link to somewhere else is refused', () => {
  // The whole point. Each of these would have been fetched by a provider using
  // our account.
  const links = [
    'https://example.com/cat.jpg',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/admin',
    'file:///etc/passwd',
    'https://127.0.0.1/',
  ]

  for (const link of links) {
    const result = checkImageDataUrl(link)
    assert.equal(result.ok, false, `${link} must not be accepted`)
    assert.match((result as { reason: string }).reason, /not as a link/)
  }
})

test('a data url that is not an image is refused', () => {
  const body = PIXEL.slice(PIXEL.indexOf(',') + 1)

  for (const type of ['text/html', 'application/pdf', 'image/svg+xml']) {
    const result = checkImageDataUrl(`data:${type};base64,${body}`)
    assert.equal(result.ok, false, `${type} must not be accepted`)
  }
})

test('svg specifically stays out', () => {
  // It is an image type and it is also a script container. A model reading it
  // is harmless; a browser later rendering what we stored is not.
  const body = PIXEL.slice(PIXEL.indexOf(',') + 1)
  const result = checkImageDataUrl(`data:image/svg+xml;base64,${body}`)
  assert.equal(result.ok, false)
})

test('an oversized photo is named as such rather than dropped', () => {
  const huge = `data:image/jpeg;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS)}`
  const result = checkImageDataUrl(huge)

  // The body limit would also stop this, but with a bare 413 that says nothing
  // about which field was at fault.
  assert.equal(result.ok, false)
  assert.match((result as { reason: string }).reason, /too large/)
})

test('an empty or malformed payload is refused', () => {
  for (const value of ['', 'data:image/png;base64,', 'data:image/png;base64,!!!', 'data:']) {
    assert.equal(checkImageDataUrl(value).ok, false, `"${value.slice(0, 24)}" must be refused`)
  }
})

test('the check does not decode the payload', () => {
  // Several megabytes of base64 decoded on every upload would cost more than
  // the check is worth, and a malformed image is rejected by the model anyway.
  // A payload that is valid base64 but not a real PNG still passes here.
  const notReallyAnImage = `data:image/png;base64,${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='}`
  assert.equal(checkImageDataUrl(notReallyAnImage).ok, true)
})

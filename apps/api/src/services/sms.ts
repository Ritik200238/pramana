/**
 * One-time code delivery.
 *
 * Until now nothing sent anything. `requestCode` wrote a challenge to the
 * database and returned, and the code was surfaced only in the development
 * response. In production that field is withheld — correctly — which meant the
 * code existed nowhere a person could reach it and every sign-in was
 * permanently impossible. The endpoint answered 200 the whole time.
 *
 * The vendor is deliberately not compiled in. India requires DLT registration
 * with an approved sender id and approved templates before a transactional SMS
 * will deliver at all, so the operator has to do vendor-specific work no matter
 * what this file says. Encoding one vendor's parameter names here would add a
 * code change to that process without removing any of it.
 *
 * So: a port, and an adapter configured as data. The request shape is the
 * operator's to describe, which also means this file never guesses at an API it
 * cannot verify.
 */

export interface SmsMessage {
  /** E.164. */
  to: string
  code: string
  expiresInMinutes: number
}

export interface SmsSender {
  readonly name: string
  send(message: SmsMessage): Promise<void>
}

export class SmsDeliveryError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'SmsDeliveryError'
    this.status = status
  }
}

/**
 * Development only.
 *
 * Writes the code to the log so a developer can sign in without a vendor
 * account. It refuses to be constructed in production, because a sender that
 * silently logs instead of sending is the exact failure this file exists to
 * remove.
 */
export class ConsoleSmsSender implements SmsSender {
  readonly name = 'console'
  // Written out rather than declared as a constructor parameter property:
  // Node's type stripping does not support those.
  private readonly log: (message: string) => void

  constructor(log: (message: string) => void, isProduction: boolean) {
    if (isProduction) {
      throw new Error('ConsoleSmsSender must never be used in production')
    }
    this.log = log
  }

  async send(message: SmsMessage): Promise<void> {
    this.log(`[sms] ${message.to} -> ${message.code} (${message.expiresInMinutes} min)`)
  }
}

export interface HttpSmsConfig {
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs?: number
  label?: string
}

/**
 * Sends through any HTTP provider, described by configuration.
 *
 * The body is a JSON template containing `{{to}}`, `{{code}}` and `{{expiry}}`.
 * Substitution happens on the parsed structure rather than the raw string, so a
 * value can never break out of its field or inject JSON.
 *
 * For example, MSG91 — whose endpoint and headers are documented at
 * https://api.msg91.com/api/v5/otp with an `authkey` header — is configured
 * entirely through env, with the template id and parameter names the operator's
 * DLT registration actually approved.
 */
export class HttpSmsSender implements SmsSender {
  readonly name: string
  private readonly config: HttpSmsConfig

  constructor(config: HttpSmsConfig) {
    this.config = config
    this.name = config.label ?? new URL(config.url).host
  }

  async send(message: SmsMessage): Promise<void> {
    const payload = fill(this.config.body, message)

    let response: Response
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      })
    } catch (error) {
      // A person is staring at a "sending…" spinner. Failing fast and honestly
      // beats a request that hangs until their patience runs out.
      throw new SmsDeliveryError(
        `SMS provider unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      )
    }

    if (!response.ok) {
      // The body is read but deliberately not attached to the error: provider
      // errors routinely echo the message back, and the message contains the
      // code.
      await response.text().catch(() => '')
      throw new SmsDeliveryError('SMS provider rejected the request', response.status)
    }
  }
}

/**
 * Substitute placeholders into a parsed template.
 *
 * Structural rather than textual on purpose. Interpolating into raw JSON text
 * would let a phone number containing a quote change the shape of the request.
 */
function fill(template: unknown, message: SmsMessage): unknown {
  if (typeof template === 'string') {
    return template
      .replaceAll('{{to}}', message.to)
      .replaceAll('{{code}}', message.code)
      .replaceAll('{{expiry}}', String(message.expiresInMinutes))
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, message))
  if (template && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map(([key, value]) => [
        key,
        fill(value, message),
      ]),
    )
  }
  return template
}

export interface SenderConfig {
  isProduction: boolean
  url?: string | undefined
  headers?: string | undefined
  body?: string | undefined
  log: (message: string) => void
}

/**
 * Choose a sender, or refuse to start.
 *
 * A production deployment with no configured provider is not a degraded
 * deployment — it is one where nobody can ever sign in. That is a boot failure,
 * in the same spirit as the config validator: fail before serving, not on the
 * first person who tries.
 */
export function createSmsSender(config: SenderConfig): SmsSender {
  if (config.url) {
    let headers: Record<string, string> = {}
    let body: unknown

    try {
      headers = config.headers ? (JSON.parse(config.headers) as Record<string, string>) : {}
    } catch {
      throw new Error('SMS_PROVIDER_HEADERS must be a JSON object')
    }

    try {
      body = config.body ? JSON.parse(config.body) : {}
    } catch {
      throw new Error('SMS_PROVIDER_BODY must be valid JSON')
    }

    if (!JSON.stringify(body).includes('{{code}}')) {
      // Catching this at boot rather than discovering it from users who receive
      // a blank message.
      throw new Error('SMS_PROVIDER_BODY must contain the {{code}} placeholder')
    }

    return new HttpSmsSender({ url: config.url, headers, body })
  }

  if (config.isProduction) {
    throw new Error(
      'No SMS provider configured. Set SMS_PROVIDER_URL, SMS_PROVIDER_HEADERS and ' +
        'SMS_PROVIDER_BODY. Without one, no user can sign in and the server would ' +
        'answer 200 to every code request while delivering nothing.',
    )
  }

  return new ConsoleSmsSender(config.log, config.isProduction)
}

import nodemailer from 'nodemailer'

type Transport = ReturnType<typeof nodemailer.createTransport>

interface EmailConfig {
    host: string
    port: number
    secure: boolean
    user: string
    pass: string
    to: string
    from: string
}

let transporter: Transport | null = null
let warned = false

// Email settings are read from the environment (kept in .env) so the SMTP
// password never lives in config.json. Enable with EMAIL_ENABLED=true.
function getConfig(): EmailConfig | null {
    const enabled = process.env.EMAIL_ENABLED === 'true'
    const user = process.env.EMAIL_USER?.trim()
    const pass = process.env.EMAIL_PASS?.trim()
    const to = (process.env.EMAIL_TO || process.env.EMAIL_USER || '').trim()
    if (!enabled || !user || !pass || !to) return null
    return {
        host: process.env.EMAIL_SMTP_HOST?.trim() || 'smtp.gmail.com',
        port: Number(process.env.EMAIL_SMTP_PORT) || 465,
        secure: process.env.EMAIL_SMTP_SECURE !== 'false',
        user,
        pass,
        to,
        from: process.env.EMAIL_FROM?.trim() || user
    }
}

export function emailEnabled(): boolean {
    return getConfig() != null
}

export async function sendEmail(subject: string, text: string): Promise<void> {
    const cfg = getConfig()
    if (!cfg) return
    try {
        if (!transporter) {
            transporter = nodemailer.createTransport({
                host: cfg.host,
                port: cfg.port,
                secure: cfg.secure,
                auth: { user: cfg.user, pass: cfg.pass }
            })
        }
        await transporter.sendMail({ from: cfg.from, to: cfg.to, subject, text })
    } catch (err) {
        // A notification failure must never crash a run; warn once and move on.
        if (!warned) {
            warned = true
            console.error(`[EMAIL] Failed to send mail: ${err instanceof Error ? err.message : String(err)}`)
        }
    }
}

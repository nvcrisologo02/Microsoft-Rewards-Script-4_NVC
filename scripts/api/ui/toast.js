export function toast(message, kind = 'ok') {
    let host = document.getElementById('toasts')
    if (!host) {
        host = document.createElement('div')
        host.id = 'toasts'
        document.body.appendChild(host)
    }
    const el = document.createElement('div')
    el.className = kind === 'err' ? 'toast err' : 'toast'
    el.textContent = message
    host.appendChild(el)
    setTimeout(() => el.remove(), 4000)
}

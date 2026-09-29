export function studentLoginEmail(studentCode) {
  const hex = Array.from(new TextEncoder().encode(String(studentCode).trim()), byte => byte.toString(16).padStart(2, '0')).join('')
  return `s-${hex}@students.studentsend.invalid`
}

export function decodeVapidKey(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '='))
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

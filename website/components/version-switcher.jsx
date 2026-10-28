'use client'
// Switches between the current docs and archived majors (versions.json). Each
// version is its own static build under its own base path, so this navigates
// with a full page load to the same page in the other version.

const versions = JSON.parse(process.env.DOCS_VERSIONS)
const label = process.env.DOCS_LABEL

export function VersionSwitcher() {
  if (versions.length < 2) return null
  const current = process.env.DOCS_ARCHIVED ? label : versions[0].label
  const go = (e) => {
    const target = versions.find((v) => v.label === e.target.value)
    const here = versions.find((v) => v.label === current)
    const page = window.location.pathname.slice(here.basePath.length)
    window.location.href = target.basePath + page
  }
  return (
    <select
      aria-label="Docs version"
      value={current}
      onChange={go}
      style={{ background: 'transparent', border: '1px solid currentColor', borderRadius: 6, padding: '2px 6px', fontSize: 13 }}
    >
      {process.env.DOCS_ARCHIVED && <option value={label}>{label}</option>}
      {versions.map((v) => (
        <option key={v.label} value={v.label}>
          {v.label}
        </option>
      ))}
    </select>
  )
}

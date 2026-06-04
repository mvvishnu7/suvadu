import { useEffect, useState } from 'react'
import type { WorkspaceStatus, RepoSummary, RepoDetail, SummaryBlock, BrowseResult, AppSettings, DoctorStatus } from './types'

// ── Folder navigator modal ────────────────────────────────────────────────────

function FolderNavigator({ onClose, onAdd, onGoToSettings }: { onClose: () => void; onAdd: (p: string, name: string) => void; onGoToSettings: () => void }) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState<'idle' | 'adding' | 'indexing'>('idle')
  const [error, setError] = useState<string | null>(null)

  function navigate(p: string) {
    setLoading(true)
    setSelected(null)
    setError(null)
    fetch(`/api/browse?path=${encodeURIComponent(p)}`)
      .then(r => r.json())
      .then((data: BrowseResult & { error?: string }) => {
        if (data.error) { setError(data.error); return; }
        setBrowse(data)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { navigate('~') }, [])

  async function handleAdd() {
    if (!selected) return
    setAdding('adding')
    setError(null)
    try {
      const name = selected.split('/').pop() ?? selected
      setAdding('indexing')
      const res = await fetch('/api/repos/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected, name })
      })
      const data = await res.json() as { ok?: boolean; error?: string; code?: string; name?: string }
      if (data.code === 'CREDENTIALS_MISSING') {
        setError('CREDENTIALS_MISSING')
        return
      }
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed')
      onAdd(selected, data.name ?? name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding('idle')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-stone-50 rounded-2xl shadow-lg w-[520px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <h3 className="font-semibold text-stone-900">Add repository</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-lg leading-none">✕</button>
        </div>

        {/* Breadcrumb */}
        <div className="px-5 py-2 border-b border-stone-100 flex items-center gap-1 text-xs text-stone-400 font-mono">
          {browse?.current ?? '…'}
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading && <p className="text-sm text-stone-400 px-2 py-3">Loading…</p>}
          {!loading && browse && (
            <ul className="space-y-0.5">
              {browse.parent && (
                <li>
                  <button
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-stone-500 hover:bg-stone-100 flex items-center gap-2"
                    onClick={() => navigate(browse.parent!)}
                  >
                    <span>↑</span> ..
                  </button>
                </li>
              )}
              {browse.dirs.map(d => (
                <li key={d.path}>
                  <button
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${
                      selected === d.path
                        ? 'bg-amber-50 text-amber-700 font-medium'
                        : 'hover:bg-stone-50 text-stone-700'
                    }`}
                    onClick={() => setSelected(d.path === selected ? null : d.path)}
                    onDoubleClick={() => navigate(d.path)}
                  >
                    <span className="text-stone-400">📁</span>
                    {d.name}
                    <span className="ml-auto text-stone-300 text-xs">double-click to open</span>
                  </button>
                </li>
              ))}
              {browse.dirs.length === 0 && <p className="text-sm text-stone-400 px-3 py-2">No subdirectories</p>}
            </ul>
          )}
        </div>

        {error === 'CREDENTIALS_MISSING' && (
          <div className="px-5 py-2 text-xs text-red-600 flex items-center gap-2">
            No sources configured.{' '}
            <button onClick={() => { onClose(); onGoToSettings() }} className="underline font-medium">Go to Settings</button>
          </div>
        )}
        {error && error !== 'CREDENTIALS_MISSING' && <p className="px-5 py-2 text-xs text-red-600">{error}</p>}

        <div className="px-5 py-4 border-t border-stone-200 flex items-center justify-between gap-3">
          <p className="text-xs text-stone-400 truncate flex-1">
            {selected ? `Selected: ${selected}` : 'Select a folder to add as a repo'}
          </p>
          <button onClick={onClose} className="text-sm text-stone-500 hover:text-stone-700 px-3 py-1.5">Cancel</button>
          <button
            onClick={handleAdd}
            disabled={!selected || adding !== 'idle'}
            className="text-sm bg-amber-600 text-white px-4 py-1.5 rounded-lg hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {adding === 'indexing' ? 'Indexing…' : adding === 'adding' ? 'Adding…' : 'Add & index'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Install panel ─────────────────────────────────────────────────────────────

function InstallPanel({ onClose }: { onClose: () => void }) {
  const [installing, setInstalling] = useState(false)
  const [results, setResults] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function install() {
    setInstalling(true)
    setError(null)
    try {
      const res = await fetch('/api/install/claude-code', { method: 'POST' })
      const data = await res.json() as { ok?: boolean; results?: string[]; error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed')
      setResults(data.results ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-stone-50 rounded-2xl shadow-lg w-[480px]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <h3 className="font-semibold text-stone-900">Connect to Claude Code</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-lg leading-none">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {!results && (
            <>
              <p className="text-sm text-stone-600">This will:</p>
              <ul className="space-y-1.5 text-sm text-stone-600">
                {[
                  'Add Suvadu as an MCP server in ~/.claude/settings.json',
                  'Write a CLAUDE.md memory snippet into each indexed repo',
                ].map(item => (
                  <li key={item} className="flex gap-2"><span className="text-amber-500 mt-0.5">✓</span>{item}</li>
                ))}
              </ul>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="text-sm text-stone-500 px-3 py-1.5">Cancel</button>
                <button
                  onClick={install}
                  disabled={installing}
                  className="text-sm bg-amber-600 text-white px-4 py-1.5 rounded-lg hover:bg-amber-700 disabled:opacity-40"
                >
                  {installing ? 'Installing…' : 'Install'}
                </button>
              </div>
            </>
          )}
          {results && (
            <>
              <p className="text-sm font-medium text-emerald-700">Done</p>
              <ul className="space-y-1">
                {results.map((r, i) => <li key={i} className="text-xs text-stone-600 flex gap-2"><span className="text-emerald-500">✓</span>{r}</li>)}
              </ul>
              <p className="text-xs text-stone-400 pt-1">Restart Claude Code for MCP changes to take effect.</p>
              <div className="flex justify-end pt-2">
                <button onClick={onClose} className="text-sm bg-stone-100 text-stone-700 px-4 py-1.5 rounded-lg hover:bg-stone-200">Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Settings page ─────────────────────────────────────────────────────────────

function TokenInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 pr-14 focus:outline-none focus:ring-2 focus:ring-amber-400"
      />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-stone-400 hover:text-stone-600 px-1"
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  )
}

function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [doctor, setDoctor] = useState<DoctorStatus | null>(null)

  // Jira state
  const [jiraExpanded, setJiraExpanded] = useState(false)
  const [jiraBaseUrl, setJiraBaseUrl] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraToken, setJiraToken] = useState('')
  const [jiraSaving, setJiraSaving] = useState(false)
  const [jiraMsg, setJiraMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // GitHub state
  const [githubExpanded, setGithubExpanded] = useState(false)
  const [githubToken, setGithubToken] = useState('')
  const [githubSaving, setGithubSaving] = useState(false)
  const [githubMsg, setGithubMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: AppSettings) => {
        setSettings(d)
        setJiraBaseUrl(d.jira.baseUrl)
        setJiraEmail(d.jira.email)
        setJiraExpanded(!d.jira.configured)
        setGithubExpanded(!d.github.configured)
      })
    fetch('/api/doctor')
      .then(r => r.json())
      .then(setDoctor)
  }, [])

  async function saveJira() {
    setJiraSaving(true)
    setJiraMsg(null)
    try {
      const res = await fetch('/api/settings/jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: jiraBaseUrl, email: jiraEmail, apiToken: jiraToken })
      })
      const d = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || d.error) throw new Error(d.error ?? 'Failed')
      setJiraMsg({ ok: true, text: 'Jira credentials saved.' })
      setSettings(s => s ? { ...s, jira: { ...s.jira, configured: true } } : s)
      onSaved()
    } catch (e) {
      setJiraMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setJiraSaving(false)
    }
  }

  async function saveGithub() {
    setGithubSaving(true)
    setGithubMsg(null)
    try {
      const res = await fetch('/api/settings/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: githubToken })
      })
      const d = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || d.error) throw new Error(d.error ?? 'Failed')
      setGithubMsg({ ok: true, text: 'GitHub token saved.' })
      setSettings(s => s ? { ...s, github: { ...s.github, configured: true } } : s)
      onSaved()
    } catch (e) {
      setGithubMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setGithubSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-2xl">
      <h1 className="text-xl font-semibold text-stone-900 mb-1">Settings</h1>
      <p className="text-sm text-stone-400 mb-6">
        Credentials are stored in{' '}
        <code className="bg-stone-100 px-1 rounded text-xs">.suvadu/credentials.json</code> — already gitignored, never committed.
      </p>

      {/* Prerequisites */}
      <section className="mb-8 border border-stone-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-100">
          <h2 className="font-medium text-stone-900">Prerequisites</h2>
          <p className="text-xs text-stone-400 mt-0.5">Required to run Suvadu.</p>
        </div>
        <div className="divide-y divide-stone-100">
          {doctor ? (
            <>
              {[
                { label: 'Node.js', ok: doctor.node.ok, value: doctor.node.version, note: doctor.node.ok ? `Requires ${doctor.node.required}` : doctor.node.note },
                { label: 'Git', ok: doctor.git.ok, value: doctor.git.ok ? 'Installed' : 'Not found', note: doctor.git.note },
              ].map(item => (
                <div key={item.label} className="px-5 py-3 flex items-center gap-3">
                  <span className={`text-sm ${item.ok ? 'text-emerald-500' : 'text-red-500'}`}>{item.ok ? '✓' : '✗'}</span>
                  <span className="text-sm font-medium text-stone-700 w-20">{item.label}</span>
                  <span className="text-sm text-stone-500">{item.value}</span>
                  {item.note && !item.ok && <span className="text-xs text-red-500 ml-auto">{item.note}</span>}
                  {item.note && item.ok && <span className="text-xs text-stone-400 ml-auto">{item.note}</span>}
                </div>
              ))}
            </>
          ) : (
            <div className="px-5 py-3 text-sm text-stone-400">Checking…</div>
          )}
        </div>
      </section>

      {/* Jira Cloud */}
      <section className="mb-8 border border-stone-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <h2 className="font-medium text-stone-900">Jira Cloud</h2>
            <p className="text-xs text-stone-400 mt-0.5">Fetches issue titles, descriptions, status, and comments for Jira keys found in git history.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${settings?.jira.configured ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
              {settings?.jira.configured ? 'Connected' : 'Not configured'}
            </span>
            <button onClick={() => setJiraExpanded(v => !v)}
              className="text-xs text-stone-400 hover:text-stone-600 px-2 py-1 rounded hover:bg-stone-100">
              {jiraExpanded ? 'Close' : settings?.jira.configured ? 'Edit' : 'Set up'}
            </button>
          </div>
        </div>

        {jiraExpanded && (
          <>
            <div className="px-5 py-3 bg-stone-50 border-t border-b border-stone-100 space-y-1.5">
              <p className="text-xs font-medium text-stone-500">How to get an API token</p>
              <ol className="text-xs text-stone-500 space-y-1 list-decimal list-inside">
                <li>Go to <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="text-amber-600 hover:underline">id.atlassian.com → Security → API tokens</a></li>
                <li>Click <strong>Create API token</strong>, give it a name like "suvadu"</li>
                <li>Copy the token — it's only shown once</li>
              </ol>
            </div>
            <div className="px-5 py-4 space-y-3">
              {[
                { label: 'Base URL', placeholder: 'https://your-company.atlassian.net', value: jiraBaseUrl, set: setJiraBaseUrl, type: 'text' as const, help: 'Your Atlassian instance URL' },
                { label: 'Email', placeholder: 'you@company.com', value: jiraEmail, set: setJiraEmail, type: 'email' as const, help: 'The email address on your Atlassian account' },
              ].map(f => (
                <div key={f.label}>
                  <div className="flex items-baseline justify-between mb-1">
                    <label className="text-xs font-medium text-stone-500">{f.label}</label>
                    <span className="text-xs text-stone-400">{f.help}</span>
                  </div>
                  <input type={f.type} value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.placeholder}
                    className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400" />
                </div>
              ))}
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="text-xs font-medium text-stone-500">API Token</label>
                  <span className="text-xs text-stone-400">From the Atlassian security page above</span>
                </div>
                <TokenInput value={jiraToken} onChange={setJiraToken} placeholder="paste token here" />
              </div>
              {jiraMsg && <p className={`text-xs ${jiraMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{jiraMsg.text}</p>}
              <div className="flex justify-end pt-1">
                <button onClick={saveJira} disabled={jiraSaving || !jiraBaseUrl || !jiraEmail || !jiraToken}
                  className="text-sm bg-amber-600 text-white px-4 py-1.5 rounded-lg hover:bg-amber-700 disabled:opacity-40">
                  {jiraSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* GitHub */}
      <section className="border border-stone-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <h2 className="font-medium text-stone-900">GitHub</h2>
            <p className="text-xs text-stone-400 mt-0.5">Fetches pull requests, review comments, and PR conversation comments.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${settings?.github.configured ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
              {settings?.github.configured
                ? settings.github.source === 'gh' ? 'Connected via gh CLI' : 'Connected via token'
                : 'Not configured'}
            </span>
            <button onClick={() => setGithubExpanded(v => !v)}
              className="text-xs text-stone-400 hover:text-stone-600 px-2 py-1 rounded hover:bg-stone-100">
              {githubExpanded ? 'Close' : settings?.github.configured ? 'Edit' : 'Set up'}
            </button>
          </div>
        </div>

        {/* gh CLI connected — compact state, optional override */}
        {settings?.github.source === 'gh' && !githubExpanded && (
          <div className="px-5 pb-4 border-t border-stone-100 pt-3 flex items-center justify-between">
            <p className="text-sm text-stone-500">
              Authenticated via the <code className="bg-stone-100 px-1 rounded text-xs">gh</code> CLI.
              No token needed.
            </p>
            <button onClick={() => setGithubExpanded(true)}
              className="text-xs text-stone-400 hover:text-stone-600 shrink-0 ml-4">
              Use token instead
            </button>
          </div>
        )}

        {/* Not connected or user chose to set/override with token */}
        {(settings?.github.source !== 'gh' || githubExpanded) && githubExpanded && (
          <>
            <div className="px-5 py-3 bg-stone-50 border-t border-b border-stone-100 space-y-1.5">
              <p className="text-xs font-medium text-stone-500">How to get a Personal Access Token</p>
              <ol className="text-xs text-stone-500 space-y-1 list-decimal list-inside">
                <li>Go to <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="text-amber-600 hover:underline">github.com → Settings → Developer settings → Personal access tokens</a></li>
                <li>Generate a new token (classic), select scope <strong>repo</strong></li>
                <li>Copy the token starting with <code className="bg-stone-100 px-1 rounded">ghp_</code></li>
              </ol>
              {settings?.github.source !== 'gh' && (
                <p className="text-xs text-stone-400 pt-1">
                  Alternatively, install and authenticate the <code className="bg-stone-100 px-1 rounded">gh</code> CLI — Suvadu will detect it automatically.
                </p>
              )}
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="text-xs font-medium text-stone-500">Personal Access Token</label>
                  <span className="text-xs text-stone-400">Stored in credentials.json, not in env</span>
                </div>
                <TokenInput value={githubToken} onChange={setGithubToken} placeholder="ghp_…" />
              </div>
              {githubMsg && <p className={`text-xs ${githubMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{githubMsg.text}</p>}
              <div className="flex justify-end pt-1">
                <button onClick={saveGithub} disabled={githubSaving || !githubToken}
                  className="text-sm bg-amber-600 text-white px-4 py-1.5 rounded-lg hover:bg-amber-700 disabled:opacity-40">
                  {githubSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function OverviewPanel() {
  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl">

      {/* Hero */}
      <div className="mb-10">
        <div className="flex items-center gap-3 mb-3">
          <img src="/favicon.svg" alt="Suvadu" className="w-8 h-8" />
          <h1 className="text-2xl font-semibold text-stone-900">Suvadu</h1>
        </div>
        <p className="text-base text-stone-500 leading-relaxed">
          <em>Suvadu</em> is a Tamil word meaning <strong className="text-stone-700">footprints</strong>.
        </p>
        <p className="text-base text-stone-500 leading-relaxed mt-2">
          Every commit, every PR, every review comment, every Jira ticket is a footprint —
          a trace of a decision someone made as they walked through your codebase.
          Suvadu collects those footprints so AI coding agents can follow the trail,
          not just read the current state of the ground.
        </p>
      </div>

      {/* The problem */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">The problem</h2>
        <p className="text-stone-700 leading-relaxed">
          AI coding agents can read your code, but they walk blind through its history.
          They don't know why a parameter exists, which PR introduced a flow,
          what a reviewer warned about, or what business decision drove a change.
          Every session starts from zero — no memory of the footprints left behind.
        </p>
      </section>

      {/* What Suvadu does */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">What it does</h2>
        <p className="text-stone-700 leading-relaxed">
          Suvadu indexes your repositories locally — reading commits, PRs, review comments,
          and Jira tickets — and surfaces the relevant footprints to your agent before it edits
          or reviews code. No cloud backend. No embeddings. The trail lives on your machine.
        </p>
      </section>

      {/* The footprints it collects */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">Footprints it collects</h2>
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: '🔀', label: 'Git commits', desc: 'Who changed what, when, and which Jira keys they mentioned' },
            { icon: '🔗', label: 'Co-change patterns', desc: 'Which files consistently move together across commits' },
            { icon: '⬆️', label: 'Pull requests', desc: 'What engineers shipped, the context they wrote, the files they touched' },
            { icon: '💬', label: 'Review comments', desc: 'What reviewers pushed back on, warned about, or asked to change' },
            { icon: '🎫', label: 'Jira issues & comments', desc: 'The business decisions and discussions behind the tickets' },
            { icon: '📁', label: 'File memory', desc: 'Risk level, ownership signals, and likely test locations per file' },
          ].map(item => (
            <div key={item.label} className="flex gap-3 p-3 rounded-lg border border-stone-100 bg-stone-50">
              <span className="text-lg leading-none mt-0.5">{item.icon}</span>
              <div>
                <div className="text-sm font-medium text-zinc-800">{item.label}</div>
                <div className="text-xs text-stone-500 mt-0.5">{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* What agents get */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">What agents get (MCP tools)</h2>
        <div className="space-y-3">
          {[
            {
              name: 'get_change_context',
              when: 'Before editing',
              desc: 'The footprints most relevant to the task — why this code exists, what Jira tickets and PRs are linked, risks to watch for, and tests to check.',
            },
            {
              name: 'review_change',
              when: 'Before finalizing',
              desc: 'What past reviewers cared about in this area — concerns, risky assumptions, and a checklist drawn from real review history.',
            },
            {
              name: 'explain_why_code_exists',
              when: 'When something looks surprising',
              desc: 'Follow the footprints back — evidence from commits, PRs, Jira, and review comments. Says "confidence is low" instead of guessing.',
            },
            {
              name: 'get_file_memory',
              when: 'Quick file lookup',
              desc: 'The trail for a single file — risk level, Jira keys, likely tests, and who has been here recently.',
            },
          ].map(tool => (
            <div key={tool.name} className="p-4 rounded-xl border border-stone-200 bg-white/70">
              <div className="flex items-baseline gap-3 mb-1">
                <code className="text-sm font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded">{tool.name}</code>
                <span className="text-xs text-stone-400">{tool.when}</span>
              </div>
              <p className="text-sm text-stone-600">{tool.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Boundaries */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">What it deliberately doesn't do</h2>
        <ul className="space-y-1">
          {[
            'No cloud — footprints stay on your machine',
            'No embeddings or vector search — only structured indexed data',
            'No automatic crawling — you choose what to index',
            'No write operations — read-only memory',
            'No broad Jira crawling — only keys found in your git history',
          ].map(item => (
            <li key={item} className="text-sm text-stone-500 flex gap-2">
              <span className="text-stone-300 mt-0.5">—</span>
              {item}
            </li>
          ))}
        </ul>
      </section>

      {/* Quick start */}
      <section>
        <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">Quick start</h2>
        <div className="bg-stone-900 rounded-lg p-4 font-mono text-sm space-y-3">
          <div className="space-y-1">
            <div className="text-stone-500 text-xs mb-1">1. Install and launch the dashboard</div>
            {['npm install -g suvadu', 'cd ~/my-repos', 'suvadu init', 'suvadu ui'].map(cmd => (
              <div key={cmd} className="text-stone-300">{cmd}</div>
            ))}
          </div>
          <div className="border-t border-stone-800 pt-3 space-y-1">
            <div className="text-stone-500 text-xs mb-1">2. From the dashboard — add repos, configure sources, connect your agent</div>
            <div className="text-stone-400 text-xs">Settings → add GitHub / Jira credentials</div>
            <div className="text-stone-400 text-xs">Repositories → + Add → select a folder</div>
            <div className="text-stone-400 text-xs">Connect Claude Code → writes MCP config automatically</div>
          </div>
        </div>
      </section>
    </div>
  )
}

const RISK_COLOR: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
}

function timeAgo(iso?: string): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'indexed' ? 'bg-emerald-100 text-emerald-700' :
    status === 'indexing' ? 'bg-blue-100 text-blue-700' :
    status === 'failed' ? 'bg-red-100 text-red-700' :
    'bg-stone-100 text-stone-500'
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>
      {status}
    </span>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-stone-400 uppercase tracking-wide">{label}</span>
      <span className="text-sm font-semibold text-zinc-800">{value}</span>
    </div>
  )
}

function RepoCard({ repo, selected, onClick, onRefresh }: { repo: RepoSummary; selected: boolean; onClick: () => void; onRefresh: () => void }) {
  const [indexing, setIndexing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function runAction(action: 'index' | 'update', e: React.MouseEvent) {
    e.stopPropagation()
    setIndexing(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo.name)}/${action}`, { method: 'POST' })
      const data = await res.json() as { error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed')
      onRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setIndexing(false)
    }
  }

  return (
    <div
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
        selected
          ? 'bg-amber-900/50 border border-amber-700/40'
          : 'border border-transparent hover:bg-white/5'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className={`text-sm font-medium truncate ${selected ? 'text-amber-300' : 'text-amber-100/90'}`}>{repo.name}</span>
        <StatusBadge status={indexing ? 'indexing' : repo.indexStatus} />
      </div>
      <div className="text-xs text-amber-100/45 truncate mb-1.5">{repo.path}</div>
      <div className="flex gap-3 mb-2">
        <span className="text-xs text-amber-100/55"><span className="text-amber-100/80 font-medium">{repo.indexedFiles}</span> files</span>
        <span className="text-xs text-amber-100/55"><span className="text-amber-100/80 font-medium">{repo.indexedPullRequests}</span> PRs</span>
        {repo.lastIndexedAt && <span className="text-xs text-amber-100/45">{timeAgo(repo.lastIndexedAt)}</span>}
      </div>
      {/* Action buttons */}
      <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
        <button
          disabled={indexing}
          onClick={e => runAction('index', e)}
          className="text-xs px-2 py-0.5 rounded bg-white/10 text-amber-100/70 hover:bg-white/15 hover:text-amber-100/80 disabled:opacity-40"
        >
          {indexing ? 'Indexing…' : 'Index'}
        </button>
        {repo.indexStatus === 'indexed' && (
          <button
            disabled={indexing}
            onClick={e => runAction('update', e)}
            className="text-xs px-2 py-0.5 rounded bg-white/10 text-amber-100/70 hover:bg-white/15 hover:text-amber-100/80 disabled:opacity-40"
          >
            Update
          </button>
        )}
      </div>
      {actionError && <p className="text-xs text-red-400 mt-1">{actionError}</p>}
      {repo.warnings.length > 0 && (
        <div className="mt-1 text-xs text-amber-500/70">⚠ {repo.warnings.length} warning{repo.warnings.length > 1 ? 's' : ''}</div>
      )}
    </div>
  )
}

function FileRow({ file }: { file: RepoDetail['fileMemories'][number] }) {
  const [open, setOpen] = useState(false)
  const badge = RISK_COLOR[file.riskLevel] ?? 'bg-stone-100 text-stone-500'
  return (
    <div className="border border-stone-200 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-stone-50 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${badge}`}>
          {file.riskLevel}
        </span>
        <span className="text-sm font-mono text-stone-700 truncate flex-1">{file.filePath}</span>
        <span className="text-xs text-stone-400 shrink-0">{file.commitCount} commits</span>
        <span className="text-stone-300 text-xs ml-1">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 border-t border-stone-100 bg-stone-50 space-y-2">
          <p className="text-sm text-stone-600 pt-2">{file.summary}</p>
          {file.relatedJiraKeys.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {file.relatedJiraKeys.map(key => (
                <span key={key} className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{key}</span>
              ))}
            </div>
          )}
          {file.likelyTests.length > 0 && (
            <div className="space-y-0.5">
              {file.likelyTests.map(t => (
                <div key={t} className="text-xs font-mono text-stone-400">{t}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RepoDetailPanel({ name }: { name: string }) {
  const [detail, setDetail] = useState<RepoDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [riskFilter, setRiskFilter] = useState<string>('all')

  useEffect(() => {
    setLoading(true)
    setDetail(null)
    fetch(`/api/repos/${encodeURIComponent(name)}`)
      .then(r => r.json())
      .then(setDetail)
      .finally(() => setLoading(false))
  }, [name])

  const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

  const files = (detail?.fileMemories ?? [])
    .filter(f => !filter || f.filePath.toLowerCase().includes(filter.toLowerCase()))
    .filter(f => riskFilter === 'all' || f.riskLevel === riskFilter)
    .sort((a, b) => (riskOrder[a.riskLevel] ?? 4) - (riskOrder[b.riskLevel] ?? 4))

  const counts = (detail?.fileMemories ?? []).reduce<Record<string, number>>((acc, f) => {
    acc[f.riskLevel] = (acc[f.riskLevel] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Repo summary header */}
      <div className="px-6 py-5 border-b border-stone-200 shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-lg font-semibold text-stone-900">{name}</h2>
          {detail && <StatusBadge status={detail.indexStatus} />}
        </div>

        {/* Stats row */}
        {detail && (
          <div className="flex gap-6 mb-4">
            <Stat label="Files" value={detail.indexedFiles} />
            <Stat label="Commits" value={detail.indexedCommits} />
            <Stat label="PRs" value={detail.indexedPullRequests} />
            <Stat label="Jira issues" value={detail.indexedJiraIssues} />
            {detail.lastIndexedAt && <Stat label="Last indexed" value={timeAgo(detail.lastIndexedAt)} />}
          </div>
        )}

        {/* Summary blocks */}
        {detail && detail.summaryBlocks.length > 0 && (
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 mt-1">
            {detail.summaryBlocks.map((block: SummaryBlock) => (
              <div key={block.label}>
                <p className="text-xs font-semibold text-stone-400 uppercase tracking-wide mb-1">{block.label}</p>
                <ul className="space-y-0.5">
                  {block.items.map((item, i) => (
                    <li key={i} className="text-xs text-stone-600 font-mono truncate" title={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* Warnings */}
        {detail && detail.warnings.length > 0 && (
          <div className="space-y-1 mt-3">
            {detail.warnings.map((w, i) => (
              <p key={i} className="text-xs text-orange-600">⚠ {w}</p>
            ))}
          </div>
        )}
      </div>

      {/* File filter bar */}
      <div className="px-6 py-3 border-b border-stone-200 flex gap-2 items-center shrink-0">
        <input
          className="flex-1 text-sm border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"
          placeholder="Filter files..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select
          className="text-sm border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
          value={riskFilter}
          onChange={e => setRiskFilter(e.target.value)}
        >
          <option value="all">All risk ({detail?.fileMemories.length ?? 0})</option>
          {(['critical', 'high', 'medium', 'low'] as const).map(r => (
            counts[r] ? <option key={r} value={r}>{r} ({counts[r]})</option> : null
          ))}
        </select>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {loading && <p className="text-sm text-stone-400">Loading...</p>}
        {!loading && files.length === 0 && (
          <p className="text-sm text-stone-400">No files match.</p>
        )}
        {files.map(f => <FileRow key={f.filePath} file={f} />)}
      </div>
    </div>
  )
}

export default function App() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<'overview' | 'repo' | 'settings'>('overview')
  const [error, setError] = useState<string | null>(null)
  const [showNavigator, setShowNavigator] = useState(false)
  const [showInstall, setShowInstall] = useState(false)

  function loadStatus() {
    fetch('/api/status')
      .then(r => r.json())
      .then((data: WorkspaceStatus) => setStatus(data))
      .catch(() => setError('Could not connect to Suvadu server.'))
  }

  useEffect(() => { loadStatus() }, [])

  function selectRepo(name: string) {
    setSelected(name)
    setView('repo')
  }

  function handleRepoAdded(_repoPath: string, name: string) {
    setShowNavigator(false)
    loadStatus()
    selectRepo(name)
  }

  if (error) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-stone-500 text-sm">{error}</p>
          <p className="text-stone-400 text-xs">Run <code className="bg-stone-100 px-1 rounded">suvadu ui</code> to start the server.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      {showNavigator && <FolderNavigator onClose={() => setShowNavigator(false)} onAdd={handleRepoAdded} onGoToSettings={() => setView('settings')} />}
      {showInstall && <InstallPanel onClose={() => setShowInstall(false)} />}

      <header className="bg-[var(--color-soil-header)] border-b border-[var(--color-soil-border)] px-6 py-3 flex items-center gap-3">
        <button
          onClick={() => setView('overview')}
          className="flex items-center gap-2 group"
        >
          <img src="/favicon.svg" alt="" className="w-5 h-5" />
          <span className="text-base font-semibold text-amber-100 group-hover:text-amber-400 transition-colors">Suvadu</span>
        </button>
        {status && <span className="text-xs text-amber-900/60">{status.workspaceName}</span>}
        <div className="ml-auto flex items-center gap-2">
          {status && (!status.jiraConfigured || !status.githubConfigured) && (
            <button onClick={() => setView('settings')}
              className="text-xs px-3 py-1.5 rounded-lg border border-amber-700/60 text-amber-400 hover:bg-amber-900/20">
              ⚠ Sources not configured
            </button>
          )}
          <button onClick={() => setView('settings')}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              view === 'settings'
                ? 'border-amber-600/70 bg-amber-900/30 text-amber-400'
                : 'border-[var(--color-soil-border)] text-amber-200/80 hover:text-amber-200 hover:border-amber-800'
            }`}>
            Settings
          </button>
          <button onClick={() => setShowInstall(true)}
            className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-soil-border)] text-amber-200/80 hover:text-amber-200 hover:border-amber-800">
            Connect Claude Code
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 bg-[var(--color-soil-sidebar)] flex flex-col border-r border-[var(--color-soil-border)]">
          {/* Nav links */}
          <div className="px-3 pt-4 pb-2 space-y-0.5">
            {(['overview', 'settings'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm capitalize transition-colors ${
                  view === v
                    ? 'bg-amber-900/50 text-amber-300 font-medium'
                    : 'text-amber-100/65 hover:bg-white/5 hover:text-amber-100/90'
                }`}>
                {v}
              </button>
            ))}
          </div>

          {/* Repos section */}
          <div className="px-3 pt-3 pb-1 flex items-center justify-between border-t border-[var(--color-soil-border)] mt-1">
            <p className="text-xs font-medium text-amber-100/55 uppercase tracking-wider px-1">Repositories</p>
            <button
              onClick={() => setShowNavigator(true)}
              className="text-xs text-amber-500 hover:text-amber-400 font-medium px-1"
            >
              + Add
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1.5">
            {!status && <p className="text-sm text-stone-500 px-2 py-2">Loading...</p>}
            {status?.repos.map(repo => (
              <RepoCard
                key={repo.name}
                repo={repo}
                selected={view === 'repo' && selected === repo.name}
                onClick={() => selectRepo(repo.name)}
                onRefresh={loadStatus}
              />
            ))}
          </div>
        </aside>

        <main className="flex-1 overflow-hidden bg-stone-50 flex">
          {view === 'overview' && <OverviewPanel />}
          {view === 'settings' && <SettingsPage onSaved={loadStatus} />}
          {view === 'repo' && selected && <RepoDetailPanel name={selected} />}
          {view === 'repo' && !selected && (
            <div className="flex items-center justify-center flex-1 text-stone-400 text-sm">
              Select a repository
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

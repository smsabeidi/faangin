import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, AudioLines, Check, CheckCircle2, Download, FileText, KeyRound, Layers3, LockKeyhole, Monitor, Palette, RefreshCw, Save, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Upload, UserRound, X } from 'lucide-react'
import type { AppState, CaptureSource, ConnectionReport, PresetMutation, Settings as SettingsData } from '../../shared/types'
import { OVERLAY_OPACITY } from '../../shared/types'
import { SHORTCUT_ACTIONS, resolveShortcutBindings, shortcutLabel, type ShortcutAction, type ShortcutPreset } from '../../main/shortcut-manager'
import { Field, Select, Spinner, Toggle } from './components'
import { BillingPanel } from './billing/BillingPanel'
import { PresetManager } from './Presets'
import { overlayInteractionDescription, overlayInteractionRecovery } from './overlay-interaction'
import { EMPTY_MICROPHONE_SNAPSHOT, microphoneChoices, refreshMicrophoneDevices, type MicrophoneSnapshot } from './microphone-devices'

type Run = <T>(label: string, task: () => Promise<T>, refresh?: boolean) => Promise<T | undefined>
export type SettingsSection = 'connection' | 'personalization' | 'presets' | 'capture' | 'appearance' | 'privacy'
const sections: { id: SettingsSection; label: string; icon: typeof KeyRound }[] = [
  { id: 'connection', label: 'Connection & models', icon: KeyRound },
  { id: 'personalization', label: 'Personalization', icon: UserRound },
  { id: 'presets', label: 'Presets & templates', icon: Layers3 },
  { id: 'capture', label: 'Capture & shortcuts', icon: AudioLines },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'privacy', label: 'Privacy & memory', icon: ShieldCheck },
]

export default function Settings({ state, run, notify, initialSection = 'connection', onReplayOnboarding }: { state: AppState; run: Run; notify: (message: string) => void; initialSection?: SettingsSection; onReplayOnboarding?: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [draft, setDraft] = useState<SettingsData>(state.settings)
  const [dirty, setDirty] = useState(false)
  const baseline = useRef(state.settings), currentDraft = useRef(state.settings)
  const revision = useRef(0), fieldRevisions = useRef<Partial<Record<keyof SettingsData, number>>>({})
  const shortcutRevisions = useRef<Partial<Record<ShortcutAction, number>>>({})
  const pendingSave = useRef<{ keys: Array<keyof SettingsData>; fields: Partial<Record<keyof SettingsData, number>>; shortcuts: Partial<Record<ShortcutAction, number>> } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [compatibleKey, setCompatibleKey] = useState('')
  const [compatibleKeyBusy, setCompatibleKeyBusy] = useState(false)
  const [chatConnection, setChatConnection] = useState<ConnectionReport | null>(null)
  const [chatTesting, setChatTesting] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [presetCatalog, setPresetCatalog] = useState(state.presets)
  const [connection, setConnection] = useState<ConnectionReport | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loadingSources, setLoadingSources] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [microphones, setMicrophones] = useState<MicrophoneSnapshot>(EMPTY_MICROPHONE_SNAPSHOT)
  const [loadingMicrophones, setLoadingMicrophones] = useState(false)
  const microphoneRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { microphoneRequest.current?.abort() }, [])
  const chatConfiguration = JSON.stringify([state.settings.chatProvider, state.settings.compatibleChatEndpoint, state.settings.compatibleChatModel, state.settings.compatibleChatSmartModel, state.settings.compatibleChatVision, state.settings.fastModel, state.settings.smartModel, state.keyConfigured, state.compatibleKeyConfigured])
  const savedChatConfiguration = useRef(chatConfiguration)
  savedChatConfiguration.current = chatConfiguration
  useEffect(() => { if (section !== 'connection') { setApiKey(''); setCompatibleKey('') } }, [section])
  useEffect(() => { setCompatibleKey(''); setChatConnection(null) }, [draft.compatibleChatEndpoint])
  useEffect(() => { setChatConnection(null) }, [chatConfiguration])
  const publishDraft = (next: SettingsData) => {
    currentDraft.current = next
    setDraft(next)
    setDirty(Object.keys(settingsChanges(next, baseline.current)).length > 0)
  }
  useEffect(() => {
    // Keep local edits while adopting unrelated changes from another window.
    const nextDraft = mergeSettingsDraft(currentDraft.current, baseline.current, state.settings)
    const pending = pendingSave.current
    if (pending) for (const key of pending.keys) {
      // Returning to the old baseline while a different value is being saved is still a later edit.
      if (fieldRevisions.current[key] !== pending.fields[key]) {
        if (key === 'shortcutOverrides') {
          nextDraft.shortcutOverrides = { ...nextDraft.shortcutOverrides }
          for (const action of SHORTCUT_ACTIONS) if (shortcutRevisions.current[action] !== pending.shortcuts[action]) {
            if (Object.hasOwn(currentDraft.current.shortcutOverrides, action)) nextDraft.shortcutOverrides[action] = currentDraft.current.shortcutOverrides[action]
            else delete nextDraft.shortcutOverrides[action]
          }
        } else Reflect.set(nextDraft, key, currentDraft.current[key])
      }
    }
    baseline.current = state.settings
    publishDraft(nextDraft)
  }, [state.settings])
  useEffect(() => {
    if (state.presets) setPresetCatalog(previous => !previous || state.presets!.revision >= previous.revision ? state.presets : previous)
  }, [state.presets])
  const patch = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => {
    fieldRevisions.current[key] = ++revision.current
    if (key === 'shortcutOverrides') {
      const overrides = value as SettingsData['shortcutOverrides'], previous = currentDraft.current.shortcutOverrides
      for (const action of SHORTCUT_ACTIONS) if (Object.hasOwn(overrides, action) !== Object.hasOwn(previous, action) || overrides[action] !== previous[action]) shortcutRevisions.current[action] = revision.current
    }
    publishDraft({ ...currentDraft.current, [key]: value })
  }
  const discard = () => {
    revision.current++
    for (const key of Object.keys(currentDraft.current) as Array<keyof SettingsData>) fieldRevisions.current[key] = revision.current
    publishDraft({ ...baseline.current })
  }
  const save = async () => {
    if (pendingSave.current || settingsError) return
    const submitted = { ...currentDraft.current }, before = baseline.current
    const changes = settingsChanges(submitted, before)
    if (!Object.keys(changes).length) return
    const submittedRevisions = { ...fieldRevisions.current }
    pendingSave.current = { keys: Object.keys(changes) as Array<keyof SettingsData>, fields: submittedRevisions, shortcuts: { ...shortcutRevisions.current } }
    setSaving(true)
    try {
      const result = await run('Saving settings', () => window.faangin.updateSettings(changes))
      if (result) {
        const nextBaseline = { ...baseline.current }, nextDraft = { ...currentDraft.current }
        for (const key of Object.keys(changes) as Array<keyof SettingsData>) {
          // A state event received while saving is newer than the request's baseline.
          if (sameSetting(baseline.current[key], before[key])) Reflect.set(nextBaseline, key, result[key])
          if (fieldRevisions.current[key] === submittedRevisions[key]) Reflect.set(nextDraft, key, nextBaseline[key])
        }
        baseline.current = nextBaseline
        publishDraft(nextDraft)
        notify('Settings saved on this device')
      }
    } finally { pendingSave.current = null; setSaving(false) }
  }
  const setKey = async () => {
    if (!apiKey.trim() || keyBusy || testing || chatTesting || saving) return
    const key = apiKey.trim()
    setApiKey('')
    setKeyBusy(true)
    setConnection(null)
    try {
      const result = await run('Saving encrypted key', () => window.faangin.setApiKey(key))
      if (result?.configured) notify('OpenAI key encrypted and saved')
    } finally { setKeyBusy(false) }
  }
  const test = async () => {
    setTesting(true)
    setConnection(null)
    try {
      const result = await run('Testing OpenAI model access', () => window.faangin.testConnection(), false)
      if (result) setConnection(result)
    } finally { setTesting(false) }
  }
  const compatibleEndpointSaved = !!draft.compatibleChatEndpoint && draft.compatibleChatEndpoint === state.settings.compatibleChatEndpoint
  const chatConfigDirty = (['chatProvider', 'compatibleChatEndpoint', 'compatibleChatModel', 'compatibleChatSmartModel', 'compatibleChatVision', 'fastModel', 'smartModel'] as const).some(key => !sameSetting(draft[key], state.settings[key]))
  const saveCompatibleKey = async () => {
    if (!compatibleKey.trim() || !compatibleEndpointSaved || compatibleKeyBusy || chatTesting || saving || endpointError) return
    const key = compatibleKey.trim(), endpoint = state.settings.compatibleChatEndpoint
    setCompatibleKey(''); setCompatibleKeyBusy(true); setChatConnection(null)
    try {
      const result = await run('Saving compatible provider key', () => window.faangin.setCompatibleApiKey(endpoint, key))
      if (result?.configured) notify('Compatible provider key encrypted for the saved endpoint')
    } finally { setCompatibleKeyBusy(false) }
  }
  const testChat = async () => {
    if (!state.chatConfigured || chatConfigDirty || chatTesting || saving || keyBusy || compatibleKeyBusy) return
    const submittedConfiguration = savedChatConfiguration.current
    setChatTesting(true); setChatConnection(null)
    try {
      const result = await run('Testing saved chat connection', () => window.faangin.testChatConnection(), false)
      if (result && savedChatConfiguration.current === submittedConfiguration) setChatConnection(result)
    } finally { setChatTesting(false) }
  }
  const exportDiagnostics = async () => {
    setExportingDiagnostics(true)
    try {
      const result = await run('Exporting diagnostic metadata', () => window.faangin.exportDiagnostics(), false)
      if (result) notify('Diagnostic bundle exported. It contains metadata only.')
    } finally { setExportingDiagnostics(false) }
  }
  const managePreset = async (command: PresetMutation) => {
    const result = await window.faangin.managePreset(command)
    setPresetCatalog(previous => !previous || result.revision >= previous.revision ? result : previous)
    return command.type === 'update' ? result.presets.find(preset => preset.id === command.id) ?? result : result
  }
  const interactionRecovery = overlayInteractionRecovery(state.shortcuts, state.permissions.platform)
  const shortcutPreview = previewShortcuts(draft, state.permissions.platform)
  const idleError = !Number.isInteger(draft.captureIdleMinutes) || draft.captureIdleMinutes < 0 || draft.captureIdleMinutes > 1440 ? 'Choose a whole number from 0 to 1,440 minutes.' : ''
  const endpointError = compatibleEndpointError(draft.compatibleChatEndpoint)
  const settingsError = shortcutPreview.error || idleError || endpointError
  const patchShortcut = (action: ShortcutAction, value: string | null | undefined) => {
    const overrides = { ...currentDraft.current.shortcutOverrides }
    if (value === undefined) delete overrides[action]
    else overrides[action] = value
    patch('shortcutOverrides', overrides)
  }
  const refreshSources = async () => {
    setLoadingSources(true)
    setSourceError('')
    try { setSources(await window.faangin.listCaptureSources()) } catch (error) { setSourceError(error instanceof Error ? error.message : String(error)) }
    setLoadingSources(false)
  }
  const refreshMicrophones = async () => {
    if (microphoneRequest.current) return
    const request = new AbortController(); microphoneRequest.current = request; setLoadingMicrophones(true)
    try {
      const enumerate = typeof window.faangin.listMicrophoneDevices === 'function' ? () => window.faangin.listMicrophoneDevices() : undefined
      const snapshot = await refreshMicrophoneDevices(enumerate, { signal: request.signal })
      if (!request.signal.aborted) setMicrophones(snapshot)
    } finally { if (microphoneRequest.current === request) { microphoneRequest.current = null; if (!request.signal.aborted) setLoadingMicrophones(false) } }
  }
  const microphoneOptions = microphoneChoices(microphones, draft.microphoneDeviceId)
  const selectedMicrophone = microphoneOptions.find(option => option.value === draft.microphoneDeviceId)
  const importProfile = async () => {
    const result = await run('Importing profile', () => window.faangin.importProfile(), false)
    if (result !== undefined && result !== null) { patch('profile', result); notify('Profile imported. Review the text and save your settings.') }
  }
  return <main className="settings-page"><div className="page-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h1>Settings</h1><p>A thoughtful workspace begins with the right setup.</p></div><button className="button primary" disabled={!dirty || saving || !!settingsError} onClick={() => { void save() }}>{saving ? <Spinner label="Saving"/> : <><Save size={15}/>{dirty ? 'Save changes' : 'All changes saved'}</>}</button></div>
    {onReplayOnboarding && <div className="setup-guide-card"><span className="setup-guide-icon"><Sparkles size={20}/></span><div><strong>A little guidance, whenever you need it.</strong><p>Revisit setup, permissions, and your overlay’s essential controls.</p></div><button className="button subtle small" data-onboarding-replay onClick={onReplayOnboarding}>Replay setup guide<ArrowUpRight size={14}/></button></div>}
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings categories">{sections.map(item => <button key={item.id} className={section === item.id ? 'selected' : ''} onClick={() => setSection(item.id)}><item.icon size={17}/>{item.label}</button>)}<div className="settings-nav-note"><LockKeyhole size={18}/><strong>Designed around your control.</strong><p>Your key is encrypted. Capture starts only when you choose.</p></div></nav><div className="settings-content">
    <BillingPanel/>
    {section === 'connection' && <>
      {!state.keyConfigured && <div className="getting-started"><span className="onboarding-step">1</span><div><strong>{draft.chatProvider === 'compatible' ? 'Set up live transcription' : 'Connect OpenAI'}</strong><p>Add a replacement OpenAI key for live transcription{draft.chatProvider === 'openai' ? ' and OpenAI chat' : ''}. A compatible chat provider uses its own connection below. Capture starts from the workspace.</p></div></div>}
      <SettingsCard icon={Sparkles} title="Chat provider" description="Choose where generated assistance, notes, and selected images are sent. Live transcription continues to use OpenAI.">
        <Field label="Provider for chat"><Select value={draft.chatProvider} onChange={event => { patch('chatProvider', event.target.value as SettingsData['chatProvider']); setChatConnection(null) }}><option value="openai">OpenAI</option><option value="compatible">OpenAI-compatible endpoint</option></Select></Field>
        <p className="settings-footnote">Saved chat provider: {state.settings.chatProvider === 'openai' ? 'OpenAI' : 'Compatible endpoint'} · {state.chatConfigured ? 'Configured' : 'Needs setup'}. Save changes before testing a different configuration.</p>
        <button className="button subtle small" disabled={!state.chatConfigured || chatConfigDirty || chatTesting || saving || keyBusy || compatibleKeyBusy} onClick={() => { void testChat() }}>{chatTesting ? <Spinner label="Testing saved chat models"/> : <><RefreshCw size={14}/>Test chat generation</>}</button>
        <p className="settings-footnote">This explicit test may make up to two tiny generated requests, one per configured Fast and Smart model. They may incur provider charges. It sends no session text, profile, screenshots, or audio.</p>
        {chatConnection && <ConnectionResult report={chatConnection}/>}
      </SettingsCard>
      <SettingsCard icon={KeyRound} title="OpenAI connection" description="This key powers live transcription and chat when OpenAI is selected. Requests use your OpenAI account and its usage limits."><div className="provider-card"><div className="provider-icon">O</div><div><strong>OpenAI</strong><span>OpenAI chat, vision & live transcription</span></div><span className={`connection-badge ${state.keyConfigured ? 'connected' : ''}`}><span className="status-dot"/>{state.keyConfigured ? 'Key configured' : 'Needs setup'}</span></div>
        {state.keyConfigured && <div className="saved-key"><LockKeyhole size={15}/><span>•••• •••• •••• ••••</span><small>Encrypted on this device</small></div>}
        <Field label={state.keyConfigured ? 'Replace API key' : 'API key'} description="The key is set-only. Faangin never displays your saved secret."><div className="key-input"><input type="password" value={apiKey} autoComplete="off" spellCheck={false} placeholder={state.keyConfigured ? 'Paste a replacement key' : 'Paste your OpenAI API key'} aria-label={state.keyConfigured ? 'Replacement OpenAI API key' : 'OpenAI API key'} onChange={e => setApiKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void setKey() } }}/><button className="button primary small" disabled={!apiKey.trim() || keyBusy || testing || chatTesting || saving} onClick={() => { void setKey() }}>{keyBusy ? <Spinner label="Saving"/> : <><LockKeyhole size={13}/>Save key</>}</button></div></Field>
        <div className="provider-actions"><button className="button subtle small" disabled={!state.keyConfigured || testing || keyBusy || saving} onClick={() => { void test() }}>{testing ? <Spinner label="Testing model access"/> : <><RefreshCw size={14}/>Check OpenAI model access</>}</button>{state.keyConfigured && <button className="text-button danger-text" disabled={keyBusy || testing || chatTesting} onClick={() => { setApiKey(''); setConnection(null); setChatConnection(null); void run('Removing API key', () => window.faangin.removeApiKey()) }}><X size={14}/>Remove key</button>}</div>
        {connection && <div className={`connection-result ${connection.ok ? 'success' : 'error'}`} role="status">{connection.ok ? <CheckCircle2 size={16}/> : <ShieldCheck size={16}/>}<span>{connection.message}</span></div>}
        {connection?.checks && <ul className="model-checks">{connection.checks.map(check => <li key={check.label}><div><strong>{check.label}</strong><code>{check.model}</code></div><span className={check.ok ? 'model-access-ok' : 'danger-text'}>{check.ok ? <CheckCircle2 size={14}/> : <ShieldCheck size={14}/>} {check.message}</span></li>)}</ul>}
        <p className="settings-footnote"><ShieldCheck size={12}/>Saving a key does not start capture or generate a response.</p>
      </SettingsCard>
      <SettingsCard icon={Monitor} title="Compatible chat connection" description="Use an endpoint implementing streaming Chat Completions. This connection has its own encrypted key; your OpenAI key is never reused.">
        <Field label="Exact Chat Completions URL" description="Enter the complete request URL, such as https://provider.example/v1/chat/completions. Use HTTPS, or HTTP with localhost or a literal loopback address. Localhost is pinned to 127.0.0.1 before requests."><input type="url" value={draft.compatibleChatEndpoint} spellCheck={false} autoComplete="off" placeholder="https://provider.example/v1/chat/completions" onChange={event => patch('compatibleChatEndpoint', event.target.value)}/></Field>
        {endpointError && <p className="danger-text" role="alert">{endpointError}</p>}
        <div className="field-grid"><Field label="Compatible Fast model" description="Exact provider model ID used in Fast mode."><input value={draft.compatibleChatModel} spellCheck={false} placeholder="Provider model ID" onChange={event => { patch('compatibleChatModel', event.target.value); setChatConnection(null) }}/></Field><Field label="Compatible Smart model" description="Exact provider model ID used in Smart mode. Configure it or choose Fast; there is no automatic fallback."><input value={draft.compatibleChatSmartModel} spellCheck={false} placeholder="Provider model ID for Smart mode" onChange={event => { patch('compatibleChatSmartModel', event.target.value); setChatConnection(null) }}/></Field></div>
        <Toggle label="This endpoint and these models support image inputs" description="Enable only when your provider documents vision support. With this off, image requests are blocked rather than silently dropping selected screenshots." checked={draft.compatibleChatVision} onChange={value => patch('compatibleChatVision', value)}/>
        <div className="provider-card"><div className="provider-icon"><Monitor size={19}/></div><div><strong>Separate provider credential</strong><span>Bound to the saved exact endpoint</span></div><span className={`connection-badge ${state.compatibleKeyConfigured ? 'connected' : ''}`}><span className="status-dot"/>{state.compatibleKeyConfigured ? 'Key configured' : 'No key configured'}</span></div>
        {state.compatibleKeyConfigured && <div className="saved-key"><LockKeyhole size={15}/><span>•••• •••• •••• ••••</span><small>Encrypted for this endpoint</small></div>}
        <Field label={state.compatibleKeyConfigured ? 'Replace compatible provider key' : 'Compatible provider key'} description={compatibleEndpointSaved ? 'This set-only secret will be saved for the endpoint shown above.' : 'Save the exact endpoint first, then enter its credential. Changing the endpoint clears this input and requires a key for the new destination.'}><div className="key-input"><input type="password" value={compatibleKey} autoComplete="off" spellCheck={false} disabled={!compatibleEndpointSaved || !!endpointError} placeholder={state.compatibleKeyConfigured ? 'Paste a replacement provider key' : 'Paste this endpoint’s API key'} aria-label="Compatible provider API key" onChange={event => setCompatibleKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveCompatibleKey() } }}/><button className="button primary small" disabled={!compatibleKey.trim() || !compatibleEndpointSaved || !!endpointError || compatibleKeyBusy || saving || chatTesting} onClick={() => { void saveCompatibleKey() }}>{compatibleKeyBusy ? <Spinner label="Saving"/> : <><LockKeyhole size={13}/>Save key</>}</button></div></Field>
        {state.compatibleKeyConfigured && <button className="text-button danger-text" disabled={compatibleKeyBusy || chatTesting} onClick={() => { setCompatibleKey(''); setChatConnection(null); void run('Removing compatible provider key', () => window.faangin.removeCompatibleApiKey()) }}><X size={14}/>Remove compatible key</button>}
        <p className="settings-footnote">Enter a separate credential when this service requires authentication. A local service may work without one. Changing the saved endpoint requires re-entering its key for authenticated requests. Saving configuration or a key does not send a generated request.</p>
      </SettingsCard>
      <SettingsCard icon={Sparkles} title="OpenAI models & response policy" description="Fast and Smart IDs below apply to OpenAI chat. Compatible chat uses its separate model IDs above. Speech uses the OpenAI transcription model."><div className="field-grid"><Field label="Fast model" description="Used when Fast is selected. GPT-6 Luna is suited to quick, focused help."><input list="openai-chat-models" value={draft.fastModel} onChange={e => patch('fastModel', e.target.value)} spellCheck={false}/></Field><Field label="Smart model" description="Used when Smart is selected. GPT-6.1 Sol supports deeper coding and reasoning."><input list="openai-chat-models" value={draft.smartModel} onChange={e => patch('smartModel', e.target.value)} spellCheck={false}/></Field><Field label="Transcription model" description="OpenAI Realtime transcription model."><input value={draft.transcriptionModel} onChange={e => patch('transcriptionModel', e.target.value)} spellCheck={false}/></Field><Field label="Programming language" description="Applied to coding and debugging requests."><Select value={draft.programmingLanguage} onChange={e => patch('programmingLanguage', e.target.value)}>{['Python', 'JavaScript', 'TypeScript', 'Java', 'C++', 'C', 'C#', 'Go', 'Rust', 'Swift', 'Kotlin', 'Ruby', 'SQL'].map(language => <option key={language}>{language}</option>)}</Select></Field></div><datalist id="openai-chat-models"><option value="gpt-6-luna">GPT-6 Luna · Fast</option><option value="gpt-6.1-sol">GPT-6.1 Sol · Smart</option></datalist><Toggle label="Prefer Smart mode" description="Use your Smart model by default. You can change it for each request." checked={draft.smartMode} onChange={value => patch('smartMode', value)}/></SettingsCard>
      <SettingsCard icon={AudioLines} title="Languages" description="Choose transcription and response languages independently."><div className="field-grid"><Field label="Input language" description="Spoken language for transcription."><Select value={draft.inputLanguage} onChange={e => patch('inputLanguage', e.target.value)}>{[['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['hi', 'Hindi'], ['ar', 'Arabic']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field><Field label="Response language" description="Language used for generated assistance."><Select value={draft.outputLanguage} onChange={e => patch('outputLanguage', e.target.value)}>{['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Japanese', 'Korean', 'Chinese', 'Hindi', 'Arabic'].map(label => <option key={label}>{label}</option>)}</Select></Field></div></SettingsCard>
    </>}
    {section === 'personalization' && <>
      <SettingsCard icon={UserRound} title="Your background" description="Give Faangin factual context to draw from when helping you prepare responses."><div className="profile-import"><p>Import your résumé or background, then review the extracted text.</p><button className="button subtle small" onClick={() => { void importProfile() }}><Upload size={14}/>Import PDF, DOCX, or TXT</button></div><Field label="Profile & experience" description="Only include facts you want used in requests."><textarea rows={8} value={draft.profile} onChange={e => patch('profile', e.target.value)} placeholder="Your role, experience, projects, and examples worth remembering…"/></Field>{draft.profile && <button className="text-button danger-text" onClick={() => patch('profile', '')}><X size={13}/>Clear profile</button>}</SettingsCard>
      <SettingsCard icon={FileText} title="Role & preparation" description="Ground interview assistance in the opportunity you are preparing for."><Field label="Job description & company context"><textarea rows={7} value={draft.jobDescription} onChange={e => patch('jobDescription', e.target.value)} placeholder="Paste a role description, company context, or interview focus…"/></Field></SettingsCard>
      <SettingsCard icon={SlidersHorizontal} title="Response instructions" description="Tune the tone and structure of your assistance."><Field label="Custom instructions"><textarea rows={6} value={draft.instructions} onChange={e => patch('instructions', e.target.value)} placeholder="For example: Keep replies concise. Explain tradeoffs before code. Ask when context is missing."/></Field></SettingsCard>
      <SettingsCard icon={FileText} title="Meeting note template" description="Used when you request notes for a session."><Field label="Sections & instructions"><textarea rows={5} value={draft.noteTemplate} onChange={e => patch('noteTemplate', e.target.value)}/></Field><button className="text-button" onClick={() => patch('noteTemplate', 'Summary, key points, decisions, action items with owners and due dates only if explicitly stated, and open questions.')}><RefreshCw size={13}/>Restore default template</button></SettingsCard>
    </>}
    {section === 'presets' && <>
      <p className="settings-footnote">Presets save independently of the Settings save button. Choose them explicitly for a session in the workspace; they do not start capture or send a request.</p>
      {presetCatalog ? <PresetManager presets={presetCatalog.presets} onCreate={preset => managePreset({ type: 'create', draft: preset })} onUpdate={(id, preset, expectedRevision) => managePreset({ type: 'update', id, draft: preset, revision: expectedRevision })} onDuplicate={id => managePreset({ type: 'duplicate', id })} onDelete={id => managePreset({ type: 'delete', id })} onRestoreDefaults={() => managePreset({ type: 'restore-defaults' })}/> : <p role="status" className="muted">The preset catalog is not available. Reopen Settings after the workspace connects.</p>}
    </>}
    {section === 'capture' && <>
      <SettingsCard icon={AudioLines} title="Audio sources" description="Start hands-free in the interview workspace enables microphone, computer audio, and automatic help together. Saving these controls does not begin recording."><Toggle label="Microphone" description="Capture your voice through the selected microphone input." checked={draft.microphone} onChange={value => patch('microphone', value)}/><div className="source-heading"><span className="field-label">Microphone input</span><button className="text-button" onClick={() => { void refreshMicrophones() }} disabled={loadingMicrophones}><RefreshCw size={13}/>{loadingMicrophones ? 'Refreshing devices…' : 'Refresh devices'}</button></div><Field label="Microphone device" description="The system default follows your operating system’s sound setting. A specific saved device is requested exactly; an unavailable device reports an error during capture."><Select value={draft.microphoneDeviceId} onChange={event => patch('microphoneDeviceId', event.target.value)}>{microphoneOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field><p className={['denied', 'failed', 'timeout'].includes(microphones.status) || selectedMicrophone?.availability === 'unavailable' ? 'danger-text' : 'settings-footnote'} role="status">{microphones.message}</p>{selectedMicrophone?.availability === 'unavailable' && <p className="settings-footnote">The saved input remains selected. Reconnect it, refresh after granting access, or explicitly choose another microphone before saving.</p>}{microphones.truncated && <p className="settings-footnote">This list is limited to 64 microphones. Your saved input stays visible even when it is outside the returned list.</p>}<Toggle label="Computer audio" description="Transcribe what your computer plays, including other people on a call, from the default audio output. Faangin asks you to review a short notice the first time. The screenshot source does not choose the audio output." checked={draft.systemAudio} onChange={value => patch('systemAudio', value)}/>
        <Toggle label="Automatic help" description="Understand the conversation and offer help when needed while listening. Off by default; Start hands-free opts in from the workspace." checked={draft.liveSuggestions} onChange={value => patch('liveSuggestions', value)}/>
        <Field label="Question audio source" description="For remote interviews, computer audio usually carries the interviewer and the microphone your side. These are source hints, not verified speaker identities."><Select value={draft.liveSuggestionSource} onChange={event => patch('liveSuggestionSource', event.target.value as SettingsData['liveSuggestionSource'])}><option value="system">Remote call · interviewer audio</option><option value="microphone">In person · room microphone</option></Select></Field>
        <p className="settings-footnote">While listening with Automatic help enabled, conversation from enabled inputs automatically sends bounded context to your configured chat provider and incurs provider usage. The request also includes your saved profile, role context, session notes and interview brief, response preferences, explicitly selected prior-session excerpts, and the current interview solution, and additional prior complete answers when Include additional prior answers is enabled. Screenshots are not included. No request is sent merely by saving this setting.</p>
        {draft.liveSuggestions && !(draft.liveSuggestionSource === 'system' ? draft.systemAudio : draft.microphone) && <p className="settings-footnote" role="status">Enable the selected audio source above, save changes, and start or resume listening to receive automatic help.</p>}
        <p className="settings-footnote">Device refresh lists microphones only; it does not open a stream or prompt for microphone access. Save changes before starting or resuming capture. Stop or pause capture before changing audio sources. Source health appears in the Conversation panel.</p></SettingsCard>
      <SettingsCard icon={ShieldCheck} title="Capture idle timeout" description="Stop capture after an interval without detected audio activity."><Field label="Stop after idle minutes" description="Choose a whole number from 0 to 1,440. Use 0 to disable the idle timeout."><input type="number" min="0" max="1440" step="1" value={draft.captureIdleMinutes} onChange={event => patch('captureIdleMinutes', Number(event.target.value))}/></Field>{idleError && <p className="danger-text" role="alert">{idleError}</p>}<p className="settings-footnote">Audio from enabled channels can reset this timer. After an idle stop, start capture again explicitly from the workspace.</p></SettingsCard>
      <SettingsCard icon={Monitor} title="Screen capture source" description="Choose the screen or window used when you click Capture. Refresh explicitly takes local previews; it does not send them to a provider."><div className="source-heading"><span className="field-label">Available sources</span><button className="text-button" onClick={() => { void refreshSources() }} disabled={loadingSources}><RefreshCw size={13}/>{loadingSources ? 'Refreshing' : 'Refresh'}</button></div>{sourceError && <div className="connection-result error">{sourceError}</div>}{loadingSources ? <div className="source-loading"><Spinner label="Finding screens and windows"/></div> : sources.length ? <div className="source-grid">{sources.map(source => <button className={`source-option ${draft.screenshotSourceId === source.id ? 'selected' : ''}`} key={source.id} onClick={() => patch('screenshotSourceId', source.id)} aria-pressed={draft.screenshotSourceId === source.id}>{source.thumbnail ? <img src={source.thumbnail} alt=""/> : <span className="source-no-preview"><Monitor size={24}/></span>}<span>{source.name}</span>{draft.screenshotSourceId === source.id && <CheckCircle2 size={15}/>}</button>)}</div> : <div className="source-empty"><Monitor size={24}/><p>Refresh to discover screens and windows. If none are returned, check screen recording permission below.</p></div>}{draft.screenshotSourceId && <button className="text-button" onClick={() => patch('screenshotSourceId', '')}>Use default display</button>}</SettingsCard>
      <SettingsCard icon={ShieldCheck} title="System permissions" description="Permission states are reported by your operating system."><PermissionRow label="Microphone" value={state.permissions.microphone} kind="microphone" run={run}/><PermissionRow label="Screen recording" value={state.permissions.screen} kind="screen" run={run}/><p className="settings-footnote">After changing a system permission, a restart may be required by your operating system. Manual context and saved sessions remain available.</p></SettingsCard>
      <SettingsCard icon={Settings2} title="Keyboard shortcuts" description="Registered shortcuts work while Faangin is in the background. Changes take effect after Save changes.">
        <Field label="Shortcut preset"><Select value={draft.shortcutPreset} onChange={event => patch('shortcutPreset', event.target.value as ShortcutPreset)}><option value="faangin">Faangin</option><option value="cue">Cue</option></Select></Field>
        <p className="settings-footnote">Enter combinations such as CommandOrControl+Enter or CommandOrControl+Shift+S. A blank override uses the preset. Disable an action to remove its global shortcut.</p>
        <div className="field-grid">{SHORTCUT_ACTIONS.map(action => {
          const base = shortcutPreview.defaults.find(binding => binding.action === action), preview = shortcutPreview.bindings.find(binding => binding.action === action)
          const override = draft.shortcutOverrides[action], disabled = override === null
          const label = base?.label ?? preview?.label ?? actionName(action)
          return <div key={action} style={{ display: 'grid', gap: 8 }}><Field label={label} description={preview ? `After saving: ${displayShortcut(preview.accelerator, state.permissions.platform)}` : disabled ? 'Disabled' : 'No shortcut in this preset'}><input value={typeof override === 'string' ? override : ''} placeholder={base?.accelerator ?? 'Enter a custom shortcut'} disabled={disabled} spellCheck={false} autoComplete="off" aria-label={`${label} shortcut override`} onChange={event => patchShortcut(action, event.target.value || undefined)}/></Field><label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={disabled} onChange={event => patchShortcut(action, event.target.checked ? null : undefined)}/>Disable {label.toLowerCase()} shortcut</label></div>
        })}</div>
        <button className="text-button" disabled={!Object.keys(draft.shortcutOverrides).length} onClick={() => patch('shortcutOverrides', {})}><RefreshCw size={13}/>Reset all overrides to this preset</button>
        {shortcutPreview.error && <p className="danger-text" role="alert">{shortcutPreview.error}</p>}
        <strong className="field-label">Currently registered</strong><div className="shortcut-list">{state.shortcuts.map(shortcut => <div key={shortcut.action}><span>{actionName(shortcut.action)}</span><span className={!shortcut.registered ? 'danger-text' : ''}>{shortcut.registered ? <kbd>{displayShortcut(shortcut.accelerator, state.permissions.platform)}</kbd> : 'Shortcut unavailable'}</span></div>)}</div>
        <p className="settings-footnote">Conflicts are rejected together and keep your previous shortcuts. If another app owns a shortcut, choose another combination or use the workspace control. {state.permissions.platform === 'darwin' ? 'Command' : 'Control'} + , opens Settings while this window is focused.</p>
      </SettingsCard>
    </>}
    {section === 'appearance' && <>
      <SettingsCard icon={Palette} title="Your workspace, your way" description="Keep it comfortable to read, whether you’re in the workspace or floating overlay."><Field label="Theme"><div className="theme-options">{(['dark', 'light', 'system'] as const).map(theme => <button key={theme} className={`theme-option ${draft.theme === theme ? 'selected' : ''}`} onClick={event => { event.preventDefault(); patch('theme', theme) }} aria-pressed={draft.theme === theme}><span className={`theme-preview ${theme}`}><i/><i/><i/></span><span>{theme[0].toUpperCase() + theme.slice(1)}</span>{draft.theme === theme && <CheckCircle2 size={14}/>}</button>)}</div></Field><Field label="Text size"><div className="range-field"><input type="range" min="12" max="20" step="1" value={draft.fontSize} onChange={e => patch('fontSize', Number(e.target.value))}/><output>{draft.fontSize}px</output></div></Field><Field label="Overlay background opacity" description="Lower opacity reveals the apps underneath. Text and controls stay fully opaque; 0% clears the background."><div className="range-field"><input type="range" min={OVERLAY_OPACITY.min} max={OVERLAY_OPACITY.max} step={OVERLAY_OPACITY.step} aria-label="Overlay background opacity" value={draft.opacity} onChange={e => patch('opacity', Number(e.target.value))}/><output>{Math.round(draft.opacity * 100)}%</output></div></Field><button type="button" className="button subtle small" title="Set background opacity to 94%. Save changes to apply." onClick={() => patch('opacity', .94)}><RefreshCw size={14}/>Use readable background · 94%</button><div className="appearance-sample" style={{ fontSize: draft.fontSize }}><Sparkles size={18}/><p>Clear thinking starts with a little breathing room.</p></div></SettingsCard>
      <SettingsCard icon={Monitor} title="Overlay interaction" description="Controls use the normal arrow. Text fields keep the text editing cursor while the overlay is interactive."><p className="settings-footnote" role="status">{overlayInteractionDescription(!!state.overlayClickThrough, interactionRecovery.hint)}</p><button className="button subtle small" disabled={saving} onClick={() => { void run('Opening interactive overlay', async () => { await window.faangin.openWindow('overlay'); await window.faangin.setClickThrough(false) }, false) }}><Monitor size={14}/>{state.overlayClickThrough ? 'Make overlay interactive' : 'Open interactive overlay'}</button><button type="button" className="button subtle small" disabled={saving} onClick={() => { void run('Resetting overlay layout', async () => { await window.faangin.resetOverlayLayout(); await window.faangin.openWindow('overlay') }, false) }}><RefreshCw size={14}/>Reset overlay size &amp; position</button>{state.permissions.platform === 'darwin' && <Toggle label="Hide Dock icon" description="Keep Faangin in the macOS menu bar. Open its workspace from the menu bar or the Show workspace shortcut. Save changes to apply." checked={draft.hideDockIcon} onChange={value => patch('hideDockIcon', value)}/>}</SettingsCard>
    </>}
    {section === 'privacy' && <>
      <SettingsCard icon={ShieldCheck} title="Visibility & data" description="Make deliberate choices about your session data."><Toggle label="Exclude from screen capture" description="Off by default. Asks the operating system to leave Faangin windows out of screenshots and screen recordings. Many capture and sharing apps still show them." checked={draft.privacyMode} onChange={value => patch('privacyMode', value)}/><div className="privacy-explanation"><Monitor size={17}/><p>Content protection is a platform capability, with no universal guarantee. Your microphone and screen still show any OS recording indicators.</p></div><Toggle label="Save session history on this device" description="When off, new sessions and further changes to the active session stay in RAM until the app closes. Save changes to apply this choice." checked={draft.historyEnabled} onChange={value => patch('historyEnabled', value)}/><p className="settings-footnote">Turning history off preserves all existing saved records, including the active session’s last saved snapshot. It does not erase old transcripts or answers. Turning it back on saves future new sessions; it does not automatically save a session already held in RAM. Preferences and presets remain saved.</p><Toggle label="Include additional prior answers" description="Include more complete answers from this session. Interview follow-ups always keep the current solution in context. Prior-session excerpts require an explicit selection in the workspace." checked={draft.includeHistory} onChange={value => patch('includeHistory', value)}/><Toggle label="Launch at login" description="Open Faangin when you sign in. Capture remains off until you start it." checked={draft.launchAtLogin} onChange={value => patch('launchAtLogin', value)}/></SettingsCard>
      <SettingsCard icon={LockKeyhole} title="Where your data goes" description="This disclosure reflects your saved configuration. Save a changed provider before it is used."><div className="data-destinations"><div><span className="destination-icon"><Monitor size={18}/></span><div><strong>This device</strong><p>Preferences, presets, and encrypted provider credentials are saved locally. {state.settings.historyEnabled ? 'New sessions, transcripts, answers, and notes are saved when history is enabled.' : 'New sessions and active-session changes stay in RAM while history is off; older saved snapshots remain on this device.'} Screenshot attachments remain in memory while the app is open.</p></div></div><div><span className="destination-icon"><AudioLines size={18}/></span><div><strong>OpenAI transcription</strong><p>Enabled audio channels are sent to OpenAI only during live capture. Raw audio is not stored.</p></div></div><div><span className="destination-icon"><Sparkles size={18}/></span><div><strong>{state.settings.chatProvider === 'openai' ? 'OpenAI chat' : 'Compatible chat endpoint'}</strong>{state.settings.chatProvider === 'compatible' && <p style={{ overflowWrap: 'anywhere' }}><code>{state.settings.compatibleChatEndpoint || 'No endpoint saved'}</code></p>}<p>When you request assistance or notes{state.settings.liveSuggestions ? ', or Automatic help prepares a reply while listening' : ''}, your saved chat provider receives bounded session context, profile, instructions, and explicitly selected prior-session excerpts. Selected screenshots are sent only with manual assistance when vision is enabled.</p></div></div></div><p className="settings-footnote"><ShieldCheck size={12}/>Saved sessions can move to recoverable Trash. Permanent deletion removes their local stored content and related in-memory attachments. Exported copies remain wherever you chose to save them.</p></SettingsCard>
      <SettingsCard icon={SlidersHorizontal} title="Diagnostic metadata" description="Export a local support bundle you can review before sharing."><p>Contains version and platform, capability and permission states, session counts, error codes, and timing summaries. It excludes API keys, session text, profile text, screenshots, local file paths, and raw error messages.</p><button className="button subtle small" disabled={exportingDiagnostics} onClick={() => { void exportDiagnostics() }}>{exportingDiagnostics ? <Spinner label="Exporting metadata"/> : <><Download size={14}/>Export diagnostic bundle</>}</button><p className="settings-footnote">Exporting does not upload the bundle or send a message.</p></SettingsCard>
    </>}
    {dirty && <div className="settings-save-bar"><span><span className="unsaved-dot"/>{settingsError || 'You have unsaved changes'}</span><div><button className="button subtle small" disabled={saving} onClick={discard}>Discard</button><button className="button primary small" disabled={saving || !!settingsError} onClick={() => { void save() }}><Check size={14}/>Save changes</button></div></div>}
    </div></div>
  </main>
}

function SettingsCard({ icon: Icon, title, description, children }: { icon: typeof KeyRound; title: string; description: string; children: ReactNode }) {
  return <section className="settings-card"><div className="settings-card-heading"><span><Icon size={18}/></span><div><h2>{title}</h2><p>{description}</p></div></div><div className="settings-card-body">{children}</div></section>
}

function PermissionRow({ label, value, kind, run }: { label: string; value: string; kind: 'microphone' | 'screen'; run: Run }) {
  const granted = value === 'granted'
  return <div className="permission-row"><div><strong>{label}</strong><span className={`permission-badge ${granted ? 'granted' : ''}`}>{granted && <Check size={11}/>} {value || 'Unknown'}</span></div><button className="button subtle small" onClick={() => { void run('Opening system permissions', () => window.faangin.openPermissionSettings(kind), false) }}>Open system settings<ArrowUpRight size={12}/></button></div>
}

function sameSetting(left: SettingsData[keyof SettingsData], right: SettingsData[keyof SettingsData]): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const first = left as Record<string, unknown>, second = right as Record<string, unknown>
  return Object.keys(first).length === Object.keys(second).length && Object.keys(first).every(key => Object.hasOwn(second, key) && Object.is(first[key], second[key]))
}

function settingsChanges(value: SettingsData, baseline: SettingsData): Partial<SettingsData> {
  return Object.fromEntries((Object.keys(value) as Array<keyof SettingsData>).filter(key => !sameSetting(value[key], baseline[key])).map(key => [key, value[key]])) as Partial<SettingsData>
}

function mergeSettingsDraft(draft: SettingsData, before: SettingsData, authoritative: SettingsData): SettingsData {
  const merged = { ...authoritative, ...settingsChanges(draft, before) }
  if (!sameSetting(draft.shortcutOverrides, before.shortcutOverrides)) {
    const overrides = { ...authoritative.shortcutOverrides }
    for (const action of SHORTCUT_ACTIONS) {
      const changed = Object.hasOwn(draft.shortcutOverrides, action) !== Object.hasOwn(before.shortcutOverrides, action) || draft.shortcutOverrides[action] !== before.shortcutOverrides[action]
      if (changed) {
        if (Object.hasOwn(draft.shortcutOverrides, action)) overrides[action] = draft.shortcutOverrides[action]
        else delete overrides[action]
      }
    }
    merged.shortcutOverrides = overrides
  }
  return merged
}

function actionName(action: string): string {
  return action.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase())
}

function displayShortcut(accelerator: string, platform: string): string {
  try { return shortcutLabel(accelerator, platform as Parameters<typeof shortcutLabel>[1]) } catch { return 'Invalid shortcut' }
}

function previewShortcuts(settings: SettingsData, platform: string) {
  const defaults = resolveShortcutBindings(settings.shortcutPreset, {}, platform as Parameters<typeof resolveShortcutBindings>[2])
  try {
    const bindings = resolveShortcutBindings(settings.shortcutPreset, settings.shortcutOverrides, platform as Parameters<typeof resolveShortcutBindings>[2])
    const seen = new Map<string, string>()
    for (const binding of bindings) {
      const duplicate = seen.get(binding.accelerator)
      if (duplicate) return { defaults, bindings, error: `${binding.label} and ${duplicate} use the same shortcut. Choose a different combination.` }
      seen.set(binding.accelerator, binding.label)
    }
    return { defaults, bindings, error: '' }
  } catch (error) {
    return { defaults, bindings: defaults, error: error instanceof Error ? error.message : 'Check your shortcut overrides.' }
  }
}

function compatibleEndpointError(value: string): string {
  if (value === '') return ''
  if (value.length > 2048 || /[\s\\?#\u0000-\u001F\u007F]/.test(value)) return 'Enter an exact URL without spaces, embedded credentials, a query, or a fragment.'
  try {
    const url = new URL(value)
    if (url.username || url.password || !url.hostname || url.search || url.hash || url.port === '0') return 'Use an endpoint without embedded credentials, a query, a fragment, or port zero.'
    if (url.protocol === 'https:') return ''
    // Check the written host, avoiding URL normalization of integer or hexadecimal IP aliases.
    const authority = value.match(/^http:\/\/([^/]+)/i)?.[1] ?? ''
    const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
    const octets = rawHost.split('.')
    const ipv4 = octets.length === 4 && octets[0] === '127' && octets.every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255) && url.hostname === rawHost
    const ipv6 = rawHost.startsWith('[') && url.hostname === '[::1]'
    const localhost = rawHost.toLowerCase() === 'localhost' && url.hostname === 'localhost'
    if (url.protocol === 'http:' && (localhost || ipv4 || ipv6)) return ''
    return 'Use HTTPS, or HTTP with localhost, a literal 127.0.0.1 address, or [::1]. Localhost is pinned to 127.0.0.1 before requests.'
  } catch { return 'Enter a valid complete Chat Completions URL.' }
}

function ConnectionResult({ report }: { report: ConnectionReport }) {
  return <><div className={`connection-result ${report.ok ? 'success' : 'error'}`} role="status">{report.ok ? <CheckCircle2 size={16}/> : <ShieldCheck size={16}/>}<span>{report.message}</span></div>{report.checks && <ul className="model-checks">{report.checks.map(check => <li key={check.label}><div><strong>{check.label}</strong><code>{check.model}</code></div><span className={check.ok ? 'model-access-ok' : 'danger-text'}>{check.ok ? <CheckCircle2 size={14}/> : <ShieldCheck size={14}/>} {check.message}</span></li>)}</ul>}</>
}

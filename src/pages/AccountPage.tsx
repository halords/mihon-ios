import { useState, type FormEvent } from 'react';
import { useNav } from '../lib/nav';
import { useOnline } from '../lib/hooks';
import { useAccount, createAccount, signInAccount, recoverAccount, signOutAccount, syncAccount, addDeviceLibrary, dismissRecoveryCode } from '../lib/account';
import Icon from '../components/Icon';
import { toast } from '../components/Feedback';

export default function AccountPage() {
  const nav = useNav(); const account = useAccount(); const online = useOnline();
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); setPassword(''); setRecovery(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to update your account.'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => mode === 'register' ? createAccount(email, password) : mode === 'recover' ? recoverAccount(email, recovery, password) : signInAccount(email, password));
  }
  const status = account.status === 'syncing' ? 'Syncing your library' : account.status === 'offline' ? 'Ready to read offline' : account.status === 'error' ? 'Changes saved on this device' : 'Your library is in sync';
  return <main className="screen settings-screen account-screen">
    <header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Account & sync</h1></header>
    <div className="account-intro"><span className="account-cloud"><Icon name="cloud" size={31} /></span><h2>Your library, everywhere.</h2><p>Sign in on your devices to keep your library and reading history together.</p></div>
    {error && <div className="error" role="alert">{error}</div>}
    {account.configured === null && <div className="spinner" role="status" aria-label="Checking account connection" />}
    {account.configured === false && <section className="settings-card"><h3>Online sync is being set up</h3><p className="muted">Accounts will be available once this server is connected. Your existing library stays available on this device.</p><button className="text-btn" onClick={nav.openBackup}>Import or export your library<Icon name="arrow" size={16} /></button></section>}
    {account.user ? <>
      <section className="settings-card account-status-card">
        <span className="account-email"><Icon name="account" size={19} />{account.user.email}</span>
        <div className="account-sync-status" role="status"><span className={`status-dot ${account.status === 'ready' ? 'online' : ''}`} /><strong>{status}</strong></div>
        <p className="muted">{account.pending ? `${account.pending} changes waiting to sync.` : 'Library, arrangement, categories, reading position, bookmarks and history.'}</p>
        <p className="account-sync-time">{account.lastSync ? `Last synced ${new Date(account.lastSync).toLocaleString()}` : 'Your first sync is getting ready.'}</p>
        {account.error && <p className="account-sync-error">{account.error}</p>}
        {!!account.quarantined && <p className="account-sync-error">{account.quarantined} record{account.quarantined === 1 ? '' : 's'} couldn’t sync and {account.quarantined === 1 ? 'was' : 'were'} set aside. Export your library and report this error.</p>}
        <button className="btn wide" disabled={!online || busy || account.status === 'syncing'} onClick={() => void run(syncAccount)}><Icon name="refresh" size={18} />{account.status === 'syncing' ? 'Syncing…' : 'Sync now'}</button>
      </section>
      {account.recoveryCode && <section className="settings-card account-recovery"><h3>Save your recovery code</h3><p className="muted">You can reset a forgotten password with this code. It is shown only now.</p><code>{account.recoveryCode}</code><div className="button-row"><button className="text-btn" onClick={() => void navigator.clipboard.writeText(account.recoveryCode).then(() => toast('Recovery code copied')).catch(() => toast('Select the code to copy it'))}>Copy code</button><button className="text-btn" onClick={dismissRecoveryCode}>I’ve saved it</button></div></section>}
      {!!account.deviceLibrary && <section className="settings-card"><h3>Add your existing device library</h3><p className="muted">The library you used before signing in is safely kept on this device. Add its titles and reading history to this account.</p><button className="btn wide" disabled={busy || !online || account.status === 'syncing'} onClick={() => void run(addDeviceLibrary)}>Add device library</button></section>}
      <section className="settings-card"><h3>Sync happens automatically</h3><p className="muted">Online changes upload automatically. Offline changes wait here until you reconnect. Downloaded chapter images stay on each device.</p><button className="text-btn" onClick={nav.openBackup}><Icon name="backup" size={18} />Import & export</button></section>
      <button className="text-btn account-signout" disabled={busy || !online} onClick={() => void run(async () => { await signOutAccount(); setMode('login'); setEmail(''); })}>Sign out</button>
      <p className="account-local-note">Your reading data stays on this device after signing out.</p>
    </> : account.configured && <>
      <section className="settings-card account-form-card"><h3>{mode === 'register' ? 'Create your account' : mode === 'recover' ? 'Recover your account' : 'Welcome back'}</h3>
        <form onSubmit={submit}>
          <label className="field-label">Username or email<input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={event => setEmail(event.target.value)} /></label>
          {mode === 'recover' && <label className="field-label">Recovery code<input autoComplete="off" required value={recovery} onChange={event => setRecovery(event.target.value)} /></label>}
          <label className="field-label">{mode === 'recover' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} maxLength={256} required value={password} onChange={event => setPassword(event.target.value)} /></label>
          {mode !== 'login' && <p className="muted account-password-note">Use at least 8 characters.</p>}
          <button className="btn wide" disabled={busy || !online}>{busy ? 'Connecting…' : mode === 'register' ? 'Create account & sync' : mode === 'recover' ? 'Reset password' : 'Sign in'}</button>
        </form>
        <button className="text-btn wide" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create an account' : 'Back to sign in'}</button>
        {mode === 'login' && <button className="text-btn wide" onClick={() => { setMode('recover'); setError(''); }}>Forgot your password?</button>}
      </section>
      <p className="account-local-note">Import and export are always available. Reading offline works as before.</p>
    </>}
  </main>;
}

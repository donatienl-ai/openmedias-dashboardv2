import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import { TEAMS, ALL_SALES, allowedNames, DEFAULT_HIDDEN, MANAGERS } from './teams';

// ---------- helpers ----------
function fmt(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
}
function todayLabel() {
  return new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
}
function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ---------- LOGIN ----------
function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) onSuccess(password);
      else setError('Mot de passe incorrect');
    } catch {
      setError('Erreur de connexion au serveur');
    } finally { setLoading(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-eyebrow">OpenMedias · Sales Dashboard</div>
        <div className="login-title">Performance<br />Commerciale</div>
        <input
          className="login-input" type="password" placeholder="Mot de passe"
          value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus
        />
        <button className="login-btn" onClick={submit} disabled={loading}>
          {loading ? 'Connexion…' : 'Accéder au dashboard'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}

// ---------- MODALE détail ----------
function DetailModal({ open, title, rows, isAmount, accent, onClose }) {
  if (!open) return null;
  const max = Math.max(1, ...rows.map((r) => (isAmount ? r.amount : r.count)));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          {rows.length === 0 ? (
            <div className="empty">Aucune donnée</div>
          ) : (
            rows.map((r, i) => {
              const v = isAmount ? r.amount : r.count;
              const pct = Math.round((v / max) * 100);
              return (
                <div className="mrow" key={i}>
                  <div className="mrow-rank">{i + 1}</div>
                  <div className="mrow-main">
                    <div className="mrow-top">
                      <span className="mrow-name">{r.name}</span>
                      <span className={`mrow-val ${v === 0 ? 'zero' : accent}`}>
                        {isAmount ? `${fmt(r.amount)} €` : r.count}
                      </span>
                    </div>
                    <div className="mrow-bar-bg">
                      <div className={`mrow-bar ${accent}-bg`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- KPI cliquable (avec métrique secondaire optionnelle) ----------
function Kpi({ label, value, sub, color, dot, glow, onClick, clickable, secondary, delta }) {
  return (
    <div
      className={`tile kpi ${glow ? 'glow-blue' : ''} col-2 ${clickable ? 'clickable' : ''}`}
      onClick={onClick}
    >
      <div className="kpi-top">
        <span className="tile-dot" style={{ background: dot }} />
        <span className={`kpi-label ${color}`}>{label}</span>
        {delta !== null && delta !== undefined && (
          <span className={`kpi-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {Math.abs(delta)}%
          </span>
        )}
        {clickable && <span className="kpi-expand">⤢</span>}
      </div>
      <div className="kpi-num">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {secondary && (
        <div className="kpi-secondary">
          {(Array.isArray(secondary) ? secondary : [secondary]).map((sec, i) => (
            <span className="kpi-sec-item" key={i}>
              <span className="kpi-sec-dot" style={{ background: sec.dot }} />
              <span className="kpi-sec-val">{sec.value}</span>
              <span className="kpi-sec-label">{sec.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TileHead({ dotClass, title, clickable }) {
  return (
    <div className="tile-head">
      <span className={`tile-dot ${dotClass}`} />
      <span className="tile-title">{title}</span>
      {clickable && <span className="tile-expand">⤢ détail</span>}
    </div>
  );
}

// Top liste compacte (seulement ceux > 0, max 6)
function TopList({ rows, isAmount, color, max = 6 }) {
  const active = (rows || []).filter((r) => (isAmount ? r.amount : r.count) > 0);
  if (active.length === 0) return <div className="empty">Aucune donnée</div>;
  const top = active.slice(0, max);
  return (
    <div className="toplist">
      {top.map((r, i) => (
        <div className="toprow" key={i}>
          <div className="toprank">{i + 1}</div>
          <div className="topname">{r.name}</div>
          <div className={`topval ${color}`}>
            {isAmount ? `${fmt(r.amount)} €` : r.count}
          </div>
        </div>
      ))}
    </div>
  );
}

function DarkTooltip({ active, payload, label, suffix }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: '#101B30', border: '1px solid #1B2A45', borderRadius: 8,
      padding: '8px 12px', fontSize: 12, color: '#fff',
    }}>
      <div style={{ color: '#8B8BB0', marginBottom: 2 }}>{label}</div>
      {payload.length === 1 ? (
        <div style={{ fontWeight: 700 }}>{fmt(payload[0].value)}{suffix || ''}</div>
      ) : (
        payload.map((p, i) => (
          <div key={i} style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color || p.fill, display: 'inline-block' }} />
            <span style={{ color: '#8295B5', fontWeight: 500 }}>{p.name}</span>
            {fmt(p.value)}{suffix || ''}
          </div>
        ))
      )}
    </div>
  );
}

// ---------- SÉLECTEUR DE PÉRIODE ----------
const PRESETS = [
  { id: 'today', label: "Aujourd'hui" },
  { id: 'yesterday', label: 'Hier' },
  { id: 'this_week', label: 'Cette semaine' },
  { id: 'last_week', label: 'Semaine dernière' },
  { id: 'this_month', label: 'Ce mois' },
  { id: 'last_month', label: 'Mois dernier' },
  { id: 'last_7', label: '7 derniers jours' },
  { id: 'last_30', label: '30 derniers jours' },
];

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function PeriodSelector({ current, label, onApply }) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [cStart, setCStart] = useState(todayISO());
  const [cEnd, setCEnd] = useState(todayISO());

  const choosePreset = (id) => {
    setOpen(false);
    setShowCustom(false);
    onApply({ preset: id });
  };

  const applyCustom = () => {
    if (!cStart || !cEnd) return;
    setOpen(false);
    setShowCustom(false);
    onApply({ preset: 'custom', start: cStart, end: cEnd });
  };

  return (
    <div className="period">
      <button className="period-btn" onClick={() => setOpen((o) => !o)}>
        <span className="period-cal">📅</span>
        <span className="period-label">{label || "Aujourd'hui"}</span>
        <span className="period-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="period-backdrop" onClick={() => { setOpen(false); setShowCustom(false); }} />
          <div className="period-menu">
            {!showCustom ? (
              <>
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`period-item ${current === p.id ? 'active' : ''}`}
                    onClick={() => choosePreset(p.id)}
                  >
                    {p.label}
                    {current === p.id && <span className="period-check">✓</span>}
                  </button>
                ))}
                <div className="period-sep" />
                <button
                  className={`period-item ${current === 'custom' ? 'active' : ''}`}
                  onClick={() => setShowCustom(true)}
                >
                  Personnalisé…
                  <span className="period-arrow">›</span>
                </button>
              </>
            ) : (
              <div className="period-custom">
                <div className="period-custom-title">Choisir une plage</div>
                <label className="period-field">
                  <span>Du</span>
                  <input type="date" value={cStart} max={cEnd} onChange={(e) => setCStart(e.target.value)} />
                </label>
                <label className="period-field">
                  <span>Au</span>
                  <input type="date" value={cEnd} min={cStart} max={todayISO()} onChange={(e) => setCEnd(e.target.value)} />
                </label>
                <div className="period-custom-actions">
                  <button className="period-cancel" onClick={() => setShowCustom(false)}>Retour</button>
                  <button className="period-apply" onClick={applyCustom}>Appliquer</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- FILTRE ÉQUIPE / SALES ----------
function FilterDropdown({ icon, label, items, current, onPick, allLabel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="period">
      <button className={`period-btn ${current ? 'filter-active' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="period-cal">{icon}</span>
        <span className="period-label">{label}</span>
        <span className="period-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="period-backdrop" onClick={() => setOpen(false)} />
          <div className="period-menu filter-menu">
            <button
              className={`period-item ${!current ? 'active' : ''}`}
              onClick={() => { setOpen(false); onPick(null); }}
            >
              {allLabel}
              {!current && <span className="period-check">✓</span>}
            </button>
            <div className="period-sep" />
            {items.map((it) => (
              <button
                key={it.value}
                className={`period-item ${current === it.value ? 'active' : ''}`}
                onClick={() => { setOpen(false); onPick(it.value); }}
              >
                {it.label}
                {current === it.value && <span className="period-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- CONSOLE ADMIN CACHÉE (Ctrl+Shift+A) ----------
function AdminConsole({ open, password, onClose, period, rangeLabel }) {
  const [theme, setTheme] = useState('light');
  const [cronPreset, setCronPreset] = useState('today');
  const [auto, setAuto] = useState(false);
  const [time, setTime] = useState('08:00');
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [sched, setSched] = useState(null);
  const [logins, setLogins] = useState([]);
  const [to, setTo] = useState('');

  // Rend le user-agent lisible ("Chrome · Windows")
  const uaShort = (ua) => {
    const browser = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
      : /Firefox\//.test(ua) ? 'Firefox' : 'Navigateur';
    const os = /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'macOS'
      : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
      : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} · ${os}` : browser;
  };
  const [status, setStatus] = useState(null); // {ok, msg}
  const [busy, setBusy] = useState(false);

  // Charge les réglages serveur à l'ouverture
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    fetch('/api/admin/settings', { headers: { 'x-dashboard-password': password } })
      .then((r) => r.json())
      .then((s) => {
        setTheme(s.reportTheme || 'light'); setTo(s.reportTo || '');
        setCronPreset(s.reportPreset || 'today');
        setAuto(!!s.reportAuto); setTime(s.reportTime || '08:00');
        setDays(Array.isArray(s.reportDays) ? s.reportDays : [1, 2, 3, 4, 5]);
        setSched(s.scheduler || null);
      })
      .catch(() => {});
    fetch('/api/admin/logins', { headers: { 'x-dashboard-password': password } })
      .then((r) => r.json())
      .then((d) => setLogins(d.events || []))
      .catch(() => {});
  }, [open, password]);

  if (!open) return null;

  const payload = () => ({
    reportTheme: theme, reportTo: to, reportPreset: cronPreset,
    reportAuto: auto, reportTime: time, reportDays: days,
  });

  const save = async () => {
    setBusy(true); setStatus(null);
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
        body: JSON.stringify(payload()),
      });
      if (!r.ok) throw new Error('Sauvegarde refusée');
      const saved = await r.json();
      localStorage.setItem('om_admin_settings', JSON.stringify(saved));
      setStatus({ ok: true, msg: 'Réglages sauvegardés ✓' });
    } catch (e) {
      setStatus({ ok: false, msg: String(e.message || e) });
    } finally { setBusy(false); }
  };

  const sendTest = async () => {
    setBusy(true); setStatus({ ok: true, msg: 'Génération + envoi en cours… (10-30s)' });
    try {
      // On sauvegarde d'abord pour tester les réglages affichés
      await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
        body: JSON.stringify(payload()),
      });
      localStorage.setItem('om_admin_settings', JSON.stringify(payload()));
      // Le test suit la période actuellement sélectionnée sur le dashboard
      const r = await fetch('/api/admin/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
        body: JSON.stringify({ preset: period?.preset || 'today', start: period?.start, end: period?.end }),
      });
      const d = await r.json();
      if (!r.ok || !d.sent) throw new Error(d.error || 'Échec de l\'envoi');
      const extra = [
        d.messageId ? `ID ${d.messageId}` : null,
        d.mailjetStatus ? `statut Mailjet: ${d.mailjetStatus}` : null,
        d.keyPrefix ? `clé ${d.keyPrefix}…` : null,
      ].filter(Boolean).join(' · ');
      setStatus({ ok: true, msg: `Reporting envoyé à ${d.to.join(', ')} ✓${extra ? ` (${extra})` : ''}` });
    } catch (e) {
      setStatus({ ok: false, msg: String(e.message || e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">🛠 Console admin</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          <div className="set-hint">
            Console cachée (Ctrl/Cmd + Maj + A). Réglages du reporting email envoyé par le dashboard.
          </div>

          <div className="adm-label">Thème de l'email</div>
          <div className="adm-themes">
            <button className={`adm-theme ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>☀️ Clair</button>
            <button className={`adm-theme ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>🌙 Sombre</button>
          </div>

          <label className="set-row" style={{ marginTop: 4 }}>
            <span className="set-name">Envoi automatique du reporting</span>
            <input type="checkbox" className="set-check" checked={auto} onChange={() => setAuto((v) => !v)} />
            <span className="set-switch" />
          </label>

          <div className="adm-label">Heure d'envoi (Europe/Paris)</div>
          <input
            type="time"
            className="adm-input adm-time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />

          <div className="adm-label">Jours d'envoi</div>
          <div className="adm-days">
            {[['L', 1], ['M', 2], ['M', 3], ['J', 4], ['V', 5], ['S', 6], ['D', 0]].map(([lbl, val], idx) => (
              <button
                key={idx}
                className={`adm-day ${days.includes(val) ? 'active' : ''}`}
                onClick={() => setDays((d) => (d.includes(val) ? d.filter((x) => x !== val) : [...d, val]))}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="adm-label">Période du reporting automatique</div>
          <div className="adm-themes">
            <button className={`adm-theme ${cronPreset === 'today' ? 'active' : ''}`} onClick={() => setCronPreset('today')}>Aujourd'hui</button>
            <button className={`adm-theme ${cronPreset === 'yesterday' ? 'active' : ''}`} onClick={() => setCronPreset('yesterday')}>Hier</button>
          </div>

          <div className="adm-label">Destinataires (séparés par des virgules)</div>
          <textarea
            className="adm-input"
            rows={2}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="prenom@openmedias.fr, autre@openmedias.fr"
          />

          <div className="adm-actions">
            <button className="adm-btn ghost" onClick={save} disabled={busy}>Sauvegarder</button>
            <button className="adm-btn primary" onClick={sendTest} disabled={busy}>
              {busy ? 'Envoi…' : `📬 Envoyer un test (${rangeLabel || "Aujourd'hui"})`}
            </button>
          </div>
          {status && <div className={`adm-status ${status.ok ? 'ok' : 'ko'}`}>{status.msg}</div>}
          {sched && (sched.lastAutoSendAt || sched.lastAutoError) && (
            <div className="adm-sched">
              {sched.lastAutoSendAt && <>Dernier envoi auto : {new Date(sched.lastAutoSendAt).toLocaleString('fr-FR')}</>}
              {sched.lastAutoError && <span className="ko"> · Dernière erreur : {sched.lastAutoError}</span>}
            </div>
          )}

          <div className="adm-label" style={{ marginTop: 18 }}>
            Connexions récentes {logins.length > 0 && `(${logins.length})`}
          </div>
          {logins.length === 0 ? (
            <div className="adm-sched">Aucune connexion enregistrée depuis le dernier redémarrage.</div>
          ) : (
            <div className="adm-log">
              {logins.slice(0, 25).map((l, idx) => (
                <div className="adm-log-row" key={idx}>
                  <span className={`adm-log-dot ${l.ok ? 'ok' : 'ko'}`} title={l.ok ? 'Connexion réussie' : 'Mot de passe incorrect'} />
                  <span className="adm-log-time">{new Date(l.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="adm-log-ua">{uaShort(l.ua)}</span>
                  <span className="adm-log-ip">{l.ip}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- PARAMÈTRES ADMIN (sales visibles) ----------
function SettingsModal({ open, hidden, onToggle, onShowAll, onClose }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">⚙️ Paramètres · Sales visibles</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          <div className="set-hint">
            Désactive un commercial pour le masquer de tout le dashboard
            (listes, graphes et totaux recalculés). Réglage mémorisé sur ce navigateur.
          </div>
          {hidden.size > 0 && (
            <button className="set-showall" onClick={onShowAll}>
              Tout réafficher ({hidden.size} masqué{hidden.size > 1 ? 's' : ''})
            </button>
          )}
          {ALL_SALES.map((s) => (
            <label className="set-row" key={s}>
              <span className={`set-name ${hidden.has(s) ? 'off' : ''}`}>{s}</span>
              <input
                type="checkbox"
                className="set-check"
                checked={!hidden.has(s)}
                onChange={() => onToggle(s)}
              />
              <span className="set-switch" />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- VUE TV / PROJECTION OPENSPACE (bouton 📺) ----------
// Vue fixe plein écran pour télé d'openspace, thème clair forcé. En haut, 4 cards
// du CA du mois par équipe ; en dessous, 3 colonnes par sales : Calls du jour,
// R1 pris du jour, et CA du mois assorti d'un statut de signature (🔥 vert si le
// sales a signé cette semaine ; sinon dégradé « négatif » selon les jours ouvrés
// écoulés dans la semaine, remis à zéro chaque lundi).
const TV_REFRESH_MS = 60000;

// Statut de signature de la 3e colonne. 'ok' = a signé cette semaine.
const SIGN_STATUS = {
  ok: { emoji: '🔥', cls: 'st-ok' },
  1: { emoji: '😐', cls: 'st-1' },
  2: { emoji: '😕', cls: 'st-2' },
  3: { emoji: '😟', cls: 'st-3' },
  4: { emoji: '😰', cls: 'st-4' },
  5: { emoji: '💀', cls: 'st-5' },
};

function TvView({ password, hiddenSales, onClose }) {
  const [data, setData] = useState(null); // preset=today (calls/R1 du jour + CA du mois)
  const [week, setWeek] = useState(null); // preset=this_week (qui a signé cette semaine)
  const [err, setErr] = useState('');
  const [lastFetch, setLastFetch] = useState(null);
  const [now, setNow] = useState(new Date());
  const reqRef = useRef(0);

  // Thème clair forcé pendant la vue, restauré à la fermeture
  useEffect(() => {
    const prev = document.documentElement.getAttribute('data-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', 'light');
    return () => { document.documentElement.setAttribute('data-theme', prev); };
  }, []);

  // Fetch jour + semaine en parallèle (ignore les réponses obsolètes via reqRef)
  const fetchAll = useCallback(async () => {
    const id = ++reqRef.current;
    try {
      const [dayRes, weekRes] = await Promise.all([
        fetch('/api/dashboard?preset=today', { headers: { 'x-dashboard-password': password } }),
        fetch('/api/dashboard?preset=this_week', { headers: { 'x-dashboard-password': password } }),
      ]);
      if (!dayRes.ok) throw new Error('Erreur serveur');
      const dayJson = await dayRes.json();
      const weekJson = weekRes.ok ? await weekRes.json() : null;
      if (id === reqRef.current) {
        setData(dayJson); setWeek(weekJson); setErr(''); setLastFetch(Date.now());
      }
    } catch (e) {
      if (id === reqRef.current) setErr(String(e.message || e));
    }
  }, [password]);

  useEffect(() => {
    fetchAll();
    const it = setInterval(fetchAll, TV_REFRESH_MS);
    return () => clearInterval(it);
  }, [fetchAll]);

  // Horloge live + recalcul du "MAJ il y a Xs"
  useEffect(() => {
    const it = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(it);
  }, []);

  // Échap pour quitter
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFullscreen = () => {
    try {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    } catch { /* noop */ }
  };

  // ===== Données =====
  const d = data || {};
  const hide = new Set(hiddenSales || []);
  const keep = (r) => !hide.has(r.name);
  const firstName = (n) => n.split(' ')[0];

  // Classements par nombre (calls, R1 pris) — masqués retirés, actifs seulement
  const rankList = (block) => (block?.detail || [])
    .filter((r) => keep(r) && (r.count || 0) > 0)
    .map((r) => ({ name: r.name, count: r.count || 0 }))
    .sort((a, b) => b.count - a.count);
  const callsRank = rankList(d.calls);
  const r1Rank = rankList(d.rdvBooked?.r1);

  // CA du mois par sales (buildFullList serveur → tout le roster avec montant)
  const monthDetail = d.monthRevenue?.detail || [];
  const caByName = new Map(monthDetail.map((r) => [r.name, r.amount || 0]));

  // 4 cards : CA du mois par équipe (somme des membres)
  const teamCards = TEAMS.map((t, i) => ({
    id: t.id,
    label: t.label,
    accent: `tc-${i + 1}`,
    ca: t.members.reduce((s, name) => s + (caByName.get(name) || 0), 0),
  }));

  // 3e colonne : CA du mois par sales (tous les non masqués, triés desc)
  const caRows = monthDetail
    .filter(keep)
    .map((r) => ({ name: r.name, amount: r.amount || 0 }))
    .sort((a, b) => b.amount - a.amount);

  // Qui a signé cette semaine (jours ouvrés) — preset this_week, signatures actives.
  // Repart automatiquement à zéro chaque lundi (la plage this_week redémarre).
  const weekSigners = new Set((week?.signatures?.detail || []).map((r) => r.name));

  // Jours ouvrés écoulés cette semaine (lun=1 … ven=5 ; week-end = 5) : intensité
  // du dégradé négatif pour ceux qui n'ont pas encore signé cette semaine.
  const dow = now.getDay(); // 0=dim … 6=sam
  const workdaysElapsed = (dow === 0 || dow === 6) ? 5 : dow;

  const statusFor = (name) => (weekSigners.has(name)
    ? { ...SIGN_STATUS.ok, days: 0 }
    : { ...SIGN_STATUS[workdaysElapsed], days: workdaysElapsed });

  const agoSec = lastFetch ? Math.round((now.getTime() - lastFetch) / 1000) : null;

  const renderRankCol = (icon, title, rows, accent) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return (
      <div className="tv-col">
        <div className="tv-col-head">{icon} {title}</div>
        {rows.length === 0 ? (
          <div className="tv-empty">Aucune donnée</div>
        ) : (
          <div className="tv-rank-list">
            {rows.map((r, i) => (
              <div className={`tv-rrow rank-${i + 1}`} key={r.name}>
                <span className="tv-rrank">{i + 1}</span>
                <span className="tv-rname">{firstName(r.name)}</span>
                <span className="tv-rbar-wrap">
                  <span className={`tv-rbar ${accent}`} style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
                </span>
                <span className="tv-rval">{fmt(r.count)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="tv-root">
      <div className="tv-head">
        <div className="tv-head-left">
          <span className="tv-eyebrow">OpenMedias · Performance Commerciale</span>
          <span className="tv-period">{todayLabel().replace(/^./, (c) => c.toUpperCase())}</span>
        </div>
        <div className="tv-head-right">
          <span className="tv-clock">{now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
          {agoSec !== null && <span className="tv-maj">MAJ il y a {agoSec}s</span>}
          <button className="tv-ctrl" onClick={toggleFullscreen} title="Plein écran">⛶</button>
          <button className="tv-ctrl" onClick={onClose} title="Quitter le mode TV">✕</button>
        </div>
      </div>

      {err && <div className="tv-err">Erreur : {err}</div>}

      <div className="tv-teamcards">
        {teamCards.map((tc) => (
          <div className={`tv-teamcard ${tc.accent}`} key={tc.id}>
            <span className="tv-tc-label">{tc.label}</span>
            <span className="tv-tc-val">{fmt(tc.ca)} €</span>
            <span className="tv-tc-sub">CA du mois</span>
          </div>
        ))}
      </div>

      <div className="tv-cols">
        {renderRankCol('📞', 'Calls du jour', callsRank, 'acc-blue')}
        {renderRankCol('🤝', 'R1 pris du jour', r1Rank, 'acc-green')}
        <div className="tv-col">
          <div className="tv-col-head">💰 CA du mois</div>
          {caRows.length === 0 ? (
            <div className="tv-empty">Aucune donnée</div>
          ) : (
            <div className="tv-rank-list">
              {caRows.map((r, i) => {
                const st = statusFor(r.name);
                return (
                  <div className="tv-srow" key={r.name}>
                    <span className="tv-rrank">{i + 1}</span>
                    <span className="tv-rname">{firstName(r.name)}</span>
                    <span className="tv-samount">{fmt(r.amount)} €</span>
                    <span
                      className={`tv-badge ${st.cls}`}
                      title={st.days ? `${st.days} jour(s) ouvré(s) sans signer cette semaine` : 'A signé cette semaine'}
                    >
                      {st.emoji}{st.days ? ` ${st.days}j` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- DASHBOARD ----------
function Dashboard({ password, onLogout, theme, onToggleTheme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [period, setPeriod] = useState({ preset: 'today' }); // {preset, start?, end?}
  const [teamFilter, setTeamFilter] = useState(null);   // id d'équipe ou null
  const [saleFilter, setSaleFilter] = useState(null);   // nom de sale ou null
  const [roleFilter, setRoleFilter] = useState(null);   // 'managers' | 'sales' | null
  const [showSettings, setShowSettings] = useState(false);
  const [bdcView, setBdcView] = useState('pending'); // 'sent' | 'signed' | 'pending'
  const [showAdmin, setShowAdmin] = useState(false);
  const [showTv, setShowTv] = useState(false);

  // Console admin cachée : Ctrl/Cmd + Maj + A
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        setShowAdmin((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Resynchronise les réglages admin sauvegardés vers le serveur
  // (la mémoire serveur est volatile sur Render free)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('om_admin_settings');
      if (saved) {
        fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
          body: saved,
        }).catch(() => {});
      }
    } catch { /* noop */ }
  }, [password]);
  const [hiddenSales, setHiddenSales] = useState(() => {
    // Si l'utilisateur n'a jamais touché aux paramètres sur ce navigateur,
    // on applique le masquage par défaut (hors-équipe sauf Thomas Durand).
    try {
      const saved = localStorage.getItem('om_hidden_sales');
      return saved !== null ? JSON.parse(saved) : DEFAULT_HIDDEN;
    } catch { return DEFAULT_HIDDEN; }
  });

  // Persiste la liste des sales masqués
  useEffect(() => {
    localStorage.setItem('om_hidden_sales', JSON.stringify(hiddenSales));
  }, [hiddenSales]);

  const toggleHidden = (name) =>
    setHiddenSales((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ preset: period.preset });
      if (period.preset === 'custom') {
        qs.set('start', period.start);
        qs.set('end', period.end);
      }
      const res = await fetch(`/api/dashboard?${qs.toString()}`, {
        headers: { 'x-dashboard-password': password },
      });
      if (res.status === 401) { onLogout(); return; }
      if (!res.ok) throw new Error('Erreur serveur');
      setData(await res.json());
    } catch (e) {
      setError(String(e.message || e));
    } finally { setLoading(false); }
  }, [password, onLogout, period]);

  useEffect(() => { load(); }, [load]);

  // Envoi par mail de la VUE COURANTE — passe par une modale pour choisir les
  // destinataires (évite de spammer la liste du reporting par erreur).
  const [showEmail, setShowEmail] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [emailMsg, setEmailMsg] = useState('');
  const [emailTo, setEmailTo] = useState(() => {
    try { return localStorage.getItem('om_email_to') || ''; } catch { return ''; }
  });
  const submitEmail = useCallback(async () => {
    const to = emailTo.split(',').map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) { setEmailMsg('Indique au moins un destinataire.'); return; }
    setEmailing(true); setEmailMsg('');
    try {
      const body = { to, preset: period.preset, theme };
      if (period.preset === 'custom') { body.start = period.start; body.end = period.end; }
      const r = await fetch('/api/admin/email-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dashboard-password': password },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.sent === false) throw new Error(j.error || 'Échec');
      try { localStorage.setItem('om_email_to', emailTo); } catch { /* noop */ }
      setEmailMsg('Mail envoyé ✓');
      setShowEmail(false);
    } catch (e) {
      setEmailMsg('Échec : ' + String(e.message || e));
    } finally {
      setEmailing(false);
      setTimeout(() => setEmailMsg(''), 4000);
    }
  }, [emailTo, password, period, theme]);

  // Ajoute « mon » email aux destinataires en 1 clic. Le mémorise au premier usage.
  const addMyself = useCallback(() => {
    let me = '';
    try { me = localStorage.getItem('om_my_email') || ''; } catch { /* noop */ }
    if (!me) {
      const input = window.prompt('Quel est ton email ? (mémorisé uniquement sur ce navigateur)');
      if (!input || !input.trim()) return;
      me = input.trim();
      try { localStorage.setItem('om_my_email', me); } catch { /* noop */ }
    }
    const list = emailTo.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.includes(me)) return; // déjà présent
    const sep = emailTo.trim() ? ', ' : '';
    setEmailTo(`${emailTo.replace(/[\s,]*$/, '')}${sep}${me}`);
  }, [emailTo]);

  // Fermeture modale sur Echap
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setModal(null); setShowSettings(false); setShowEmail(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading && !data) {
    return (
      <div className="shell">
        <div className="loading-wrap">
          <div className="spinner" />
          <div>Chargement des données…</div>
        </div>
      </div>
    );
  }

  const d = data || {};
  const rangeLabel = d.range?.label || "Aujourd'hui";
  const isToday = (d.range?.preset || 'today') === 'today';

  // Couleurs de graphes adaptées au thème (les charts Recharts ne lisent pas les CSS vars)
  const isLight = theme === 'light';
  const ct = {
    axis: isLight ? '#DEE6F0' : '#1B2A45',
    tick: isLight ? '#72839F' : '#8295B5',
    tickFaint: isLight ? '#93A3BD' : '#54678A',
    tickBold: isLight ? '#33455F' : '#C3D0E3',
    labelStrong: isLight ? '#101A2E' : '#FFFFFF',
  };

  // ===== FILTRAGE ÉQUIPE / SALES + masqués (paramètres) =====
  // allowed = Set des noms autorisés, ou null = pas de filtre
  const allowed = allowedNames(teamFilter, saleFilter);
  const hidden = new Set(hiddenSales);
  const isManager = (name) => MANAGERS.includes(name);
  const roleOk = (name) => !roleFilter || (roleFilter === 'managers' ? isManager(name) : !isManager(name));
  const keepRow = (r) => (!allowed || allowed.has(r.name)) && !hidden.has(r.name) && roleOk(r.name);
  const filterRows = (rows) => (rows || []).filter(keepRow);
  const mustRecalc = !!allowed || hidden.size > 0 || !!roleFilter;
  // Recalcule un bloc {total, detail} après filtre
  const fBlock = (block, sumAmount = false) => {
    const detail = filterRows(block?.detail);
    const total = mustRecalc ? detail.reduce((s, r) => s + (r.count || 0), 0) : (block?.total ?? 0);
    const totalAmount = sumAmount
      ? (mustRecalc ? detail.reduce((s, r) => s + (r.amount || 0), 0) : (block?.totalAmount ?? 0))
      : undefined;
    return { ...block, detail, total, ...(sumAmount ? { totalAmount } : {}) };
  };

  const rdvT = {
    r1: fBlock(d.rdvToday?.r1 || { total: 0, detail: [] }),
    r2: fBlock(d.rdvToday?.r2 || { total: 0, detail: [] }),
  };
  const rdvB = {
    r1: fBlock(d.rdvBooked?.r1 || { total: 0, detail: [] }),
    r2: fBlock(d.rdvBooked?.r2 || { total: 0, detail: [] }),
  };
  const sig = fBlock(d.signatures || { total: 0, totalAmount: 0, detail: [] }, true);
  const rev = fBlock(d.revenue || { totalAmount: 0, detail: [] }, true);
  const propals = fBlock(d.propals || { total: 0, detail: [] });
  const calls = fBlock(d.calls || { total: 0, detail: [] });
  const sf = fBlock(d.salesforge || { total: 0, detail: [] });
  const bdc = {
    sent: fBlock(d.bdc?.sent || { total: 0, detail: [] }),
    signed: fBlock(d.bdc?.signed || { total: 0, detail: [] }),
    pending: fBlock(d.bdc?.pending || { total: 0, detail: [] }),
  };
  // Propositions sur Comptes (statut Salesforce "Proposition envoyée")
  const propalsComptes = fBlock(d.propalsComptes || { total: 0, detail: [] });

  // Repère "mois en cours" (sous CA & Signatures), masqué si la période EST déjà ce mois
  const isThisMonth = (d.range?.preset || 'today') === 'this_month';
  const monthRev = fBlock(d.monthRevenue || { totalAmount: 0, detail: [] }, true);
  const monthSig = fBlock(d.monthSignatures || { total: 0, totalAmount: 0, detail: [] }, true);

  // ===== % d'évolution vs période de comparaison (6 KPIs, filtres appliqués) =====
  const cmp = d.compare || null;
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
  let dCalls = null, dR1 = null, dR2 = null, dPropals = null, dSig = null, dCA = null;
  if (cmp) {
    dCalls = pct(calls.total, fBlock(cmp.calls || { total: 0, detail: [] }).total);
    dR1 = pct(rdvT.r1.total, fBlock(cmp.rdvToday?.r1 || { total: 0, detail: [] }).total);
    dR2 = pct(rdvT.r2.total, fBlock(cmp.rdvToday?.r2 || { total: 0, detail: [] }).total);
    const cmpPropals = fBlock(cmp.propals || { total: 0, detail: [] }).total
      + fBlock(cmp.propalsComptes || { total: 0, detail: [] }).total;
    dPropals = pct(propals.total + propalsComptes.total, cmpPropals);
    dSig = pct(sig.total, fBlock(cmp.signatures || { total: 0, totalAmount: 0, detail: [] }, true).total);
    dCA = pct(rev.totalAmount, fBlock(cmp.revenue || { totalAmount: 0, detail: [] }, true).totalAmount);
  }

  // Totaux calls entrants/sortants (recalculés si filtre ou masquage actif)
  const callsIn = mustRecalc
    ? calls.detail.reduce((s, r) => s + (r.inbound || 0), 0)
    : (calls.totalInbound ?? 0);
  const callsOut = mustRecalc
    ? calls.detail.reduce((s, r) => s + (r.outbound || 0), 0)
    : (calls.totalOutbound ?? 0);

  // libellé du filtre actif (pour le titre)
  const roleLabel = roleFilter === 'managers' ? 'Managers' : roleFilter === 'sales' ? 'Sales' : null;
  const baseLabel = saleFilter
    ? saleFilter
    : teamFilter
      ? (TEAMS.find((t) => t.id === teamFilter)?.label || '')
      : null;
  const filterLabel = [baseLabel, roleLabel].filter(Boolean).join(' · ') || null;

  // ouvre une modale
  const openModal = (title, rows, isAmount, accent) =>
    setModal({ title, rows: rows || [], isAmount: !!isAmount, accent: accent || 'c-blue' });

  // graphes : seulement sales > 0
  const caBySales = (rev.detail || []).filter((r) => r.amount > 0).slice(0, 8).map((r) => ({
    name: r.name.split(' ')[0], value: r.amount,
  }));
  // Calls : tous les sales avec au moins 1 call (le bloc s'agrandit en conséquence)
  const callsBySales = (calls.detail || []).filter((r) => r.count > 0).map((r) => ({
    name: r.name.split(' ')[0],
    total: r.count,
    outbound: r.outbound || 0,
    inbound: r.inbound || 0,
  }));
  const rdvPie = [
    { name: 'R1 pris', value: rdvB.r1.total, fill: '#FBBF24' },
    { name: 'R2 pris', value: rdvB.r2.total, fill: '#22D3EE' },
  ].filter((x) => x.value > 0);

  return (
    <div className="shell">
      {/* TOPBAR */}
      <div className="topbar">
        <div className="topbar-left">
          <div className="brand-eyebrow">OpenMedias · Sales Dashboard</div>
          <div className="brand-title">Performance Commerciale</div>
          <div className="context-line">
            <span>{todayLabel()}</span>
            {!isToday && <span className="period-chip">{rangeLabel}</span>}
            {filterLabel && <span className="filter-badge">{filterLabel}</span>}
            {hidden.size > 0 && <span className="hidden-chip">{hidden.size} masqué{hidden.size > 1 ? 's' : ''}</span>}
          </div>
        </div>
        <div className="topbar-right">
          <div className="controls-group">
            <FilterDropdown
              icon="👔"
              label={roleLabel || 'Rôle'}
              allLabel="Tous les rôles"
              items={[
                { value: 'managers', label: 'Managers' },
                { value: 'sales', label: 'Sales' },
              ]}
              current={roleFilter}
              onPick={(v) => { setRoleFilter(v); setSaleFilter(null); }}
            />
            <FilterDropdown
              icon="👥"
              label={teamFilter ? (TEAMS.find((t) => t.id === teamFilter)?.label || 'Équipe') : 'Équipes'}
              allLabel="Toutes les équipes"
              items={TEAMS.map((t) => ({ value: t.id, label: t.label }))}
              current={teamFilter}
              onPick={(v) => { setTeamFilter(v); setSaleFilter(null); }}
            />
            <FilterDropdown
              icon="👤"
              label={saleFilter || 'Sales'}
              allLabel="Tous les sales"
              items={(teamFilter
                ? (TEAMS.find((t) => t.id === teamFilter)?.members || [])
                : ALL_SALES
              ).filter((s) => !hidden.has(s) && roleOk(s)).map((s) => ({ value: s, label: s }))}
              current={saleFilter}
              onPick={(v) => setSaleFilter(v)}
            />
            <PeriodSelector
              current={d.range?.preset || 'today'}
              label={rangeLabel}
              onApply={(p) => setPeriod(p)}
            />
          </div>
          <div className="topbar-divider" />
          <div className="status-cluster">
            <button className="theme-btn" onClick={() => setShowTv(true)} title="Mode TV — projection openspace">
              📺
            </button>
            <button className="theme-btn" onClick={() => setShowSettings(true)} title="Paramètres">
              ⚙️
            </button>
            <button className="theme-btn" onClick={() => setShowEmail(true)} title="Envoyer cette vue par mail">
              ✉️
            </button>
            <button className="theme-btn" onClick={onToggleTheme} title={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            {emailMsg && <span className="maj">{emailMsg}</span>}
            {d.generatedAt && <span className="maj">MAJ {timeLabel(d.generatedAt)}</span>}
            <button className={`refresh-btn ${loading ? 'loading' : ''}`} onClick={load} disabled={loading}>
              <span className="refresh-icon">↻</span>
              {loading ? 'Maj…' : 'Rafraîchir'}
            </button>
          </div>
        </div>
      </div>

      {(error || d.errors) && (
        <div style={{ marginBottom: 12 }}>
          {error && <div className="err-pill"><strong>Erreur :</strong> {error}</div>}
          {d.errors && Object.entries(d.errors).map(([k, v]) => (
            <div className="err-pill" key={k}><strong>{k}</strong> — {v}</div>
          ))}
        </div>
      )}

      <div className="grid">
        {/* ===== BANDE KPI — duo cards (R1/R2 intègrent leurs "pris") ===== */}
        <Kpi label="Calls" value={calls.truncated ? `${fmt(calls.total)}+` : calls.total}
          sub={calls.truncated ? 'plafonné' : 'passés'} color="c-blue" dot="#3B82F6"
          secondary={[
            { value: callsOut, label: 'out', dot: '#2563EB' },
            { value: callsIn, label: 'in', dot: '#60A5FA' },
          ]}
          delta={dCalls}
          clickable onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue')} />
        <Kpi label="R1" value={rdvT.r1.total} sub="échanges" color="c-green" dot="#22C55E"
          secondary={{ value: rdvB.r1.total, label: 'pris', dot: '#FBBF24' }}
          delta={dR1}
          clickable onClick={() => openModal('R1 par commercial', rdvT.r1.detail, false, 'c-green')} />
        <Kpi label="R2" value={rdvT.r2.total} sub="retours" color="c-bluer2" dot="#22D3EE"
          secondary={{ value: rdvB.r2.total, label: 'pris', dot: '#FBBF24' }}
          delta={dR2}
          clickable onClick={() => openModal('R2 par commercial', rdvT.r2.detail, false, 'c-bluer2')} />
        <Kpi label="Propals" value={propals.total + propalsComptes.total} sub="envoyées" color="c-orange" dot="#F97316"
          secondary={[
            { value: propals.total, label: 'pistes', dot: '#F97316' },
            { value: propalsComptes.total, label: 'comptes', dot: '#FBBF24' },
          ]}
          delta={dPropals}
          clickable onClick={() => openModal('Propals Pistes par commercial', propals.detail, false, 'c-orange')} />
        <Kpi label="Signatures" value={sig.total} sub="deals signés" color="c-violet" dot="#3B82F6" glow
          secondary={!isThisMonth ? [{ value: monthSig.total, label: 'ce mois', dot: '#3B82F6' }] : null}
          delta={dSig} />
        <div className="tile hero-ca col-2">
          <div className="lbl">CA · {isToday ? 'du jour' : 'période'}
            {dCA !== null && dCA !== undefined && (
              <span className={`hero-delta ${dCA > 0 ? 'up' : dCA < 0 ? 'down' : 'flat'}`}>
                {dCA > 0 ? '▲' : dCA < 0 ? '▼' : '•'} {Math.abs(dCA)}%
              </span>
            )}
          </div>
          <div className="val">{fmt(rev.totalAmount)}€</div>
          <div className="sub">{isToday ? 'cumul signé' : rangeLabel.toLowerCase()}</div>
          {!isThisMonth && (
            <div className="hero-month"><span className="hero-month-dot" />ce mois · {fmt(monthRev.totalAmount)} €</div>
          )}
        </div>

        {/* ===== RANGÉE MONEY — CA + Signatures ===== */}
        <div className="tile col-8 clickable" onClick={() => openModal(`CA · ${rangeLabel} par commercial`, rev.detail, true, 'c-blue')}>
          <TileHead dotClass="bg-blue" title={`CA ${isToday ? 'du jour' : '· ' + rangeLabel} par commercial`} clickable />
          <div className="chart-box" style={{ height: 250 }}>
            {caBySales.length === 0 ? (
              <div className="empty">Aucune donnée</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={caBySales} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                  <XAxis dataKey="name" tick={{ fill: ct.tick, fontSize: 11 }} axisLine={{ stroke: ct.axis }} tickLine={false} />
                  <YAxis tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} width={50}
                    tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip content={<DarkTooltip suffix=" €" />} cursor={{ fill: 'rgba(59,130,246,0.10)' }} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={90} isAnimationActive={false}>
                    {caBySales.map((e, i) => (
                      <Cell key={i} fill={i === 0 ? '#3B82F6' : '#2563EB'} fillOpacity={i === 0 ? 1 : 0.55} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="tile col-4">
          <TileHead dotClass="bg-violet" title={isToday ? 'Signatures du jour' : `Signatures · ${rangeLabel}`} />
          {sig.detail.length === 0 ? (
            <div className="empty">Aucune signature</div>
          ) : (
            <div className="sig-scroll">
              {sig.detail.map((s, i) => (
                <div className="sig-row" key={i}>
                  <span className="sig-name">{s.name}</span>
                  <span className="sig-val">{fmt(s.amount)} €</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ===== RANGÉE ACTIVITÉ — Calls top 10 + RDV pris + SalesForge ===== */}
        <div className="tile col-5 clickable" onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue')}>
          <TileHead dotClass="bg-blue" title={`Calls par commercial${callsBySales.length > 10 ? ' · top 10' : ''}`} clickable />
          <div className="chart-box" style={{ height: Math.max(200, Math.min(callsBySales.length, 10) * 30) }}>
            {callsBySales.length === 0 ? (
              <div className="empty">Aucun call sur la période</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={callsBySales.slice(0, 10)} layout="vertical" margin={{ top: 0, right: 36, left: 8, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: ct.tick, fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(59,130,246,0.10)' }} />
                  <Bar dataKey="outbound" name="Sortants" stackId="dir" fill="#2563EB" isAnimationActive={false} />
                  <Bar dataKey="inbound" name="Entrants" stackId="dir" fill="#60A5FA" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                    <LabelList dataKey="total" position="right" fill={ct.tick} fontSize={11} fontWeight={700} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="rdv-legend">
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#2563EB' }} />Sortants<b>{callsOut}</b></span>
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#60A5FA' }} />Entrants<b>{callsIn}</b></span>
          </div>
          {callsBySales.length > 10 && <div className="see-all">⤢ Voir les {callsBySales.length} commerciaux</div>}
        </div>

        <div className="tile col-3">
          <TileHead dotClass="bg-amber" title="RDV pris — répartition" />
          <div className="chart-box" style={{ height: 200 }}>
            {rdvPie.length === 0 ? (
              <div className="empty">Aucun RDV pris</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rdvPie} margin={{ top: 24, right: 8, left: 8, bottom: 4 }} barCategoryGap="30%">
                  <XAxis dataKey="name" tick={{ fill: ct.tickBold, fontSize: 13, fontWeight: 700 }} axisLine={{ stroke: ct.axis }} tickLine={false} />
                  <YAxis tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]} maxBarSize={70} isAnimationActive={false}
                    label={{ position: 'top', fill: ct.labelStrong, fontSize: 16, fontWeight: 800 }}>
                    {rdvPie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="rdv-legend">
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#FBBF24' }} />R1 pris<b>{rdvB.r1.total}</b></span>
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#22D3EE' }} />R2 pris<b>{rdvB.r2.total}</b></span>
          </div>
        </div>

        <div className="tile col-4">
          <TileHead dotClass="bg-violet" title="BDC · DocuSign" />
          <div className="bdc-stats">
            {[
              { key: 'sent', label: 'Envoyés', color: 'c-orange', title: 'BDC envoyés par commercial' },
              { key: 'pending', label: 'En attente', color: 'c-amber', title: 'BDC en attente de signature' },
              { key: 'signed', label: 'Signés', color: 'c-green', title: 'BDC signés par commercial' },
            ].map((v) => (
              <button
                key={v.key}
                className={`bdc-stat ${bdcView === v.key ? 'active' : ''}`}
                onClick={() => setBdcView(v.key)}
              >
                <span className={`bdc-stat-val ${v.color}`}>{bdc[v.key].total}</span>
                <span className="bdc-stat-label">{v.label}</span>
              </button>
            ))}
          </div>
          {(() => {
            const meta = {
              sent: { color: 'c-orange', title: 'BDC envoyés par commercial' },
              signed: { color: 'c-green', title: 'BDC signés par commercial' },
              pending: { color: 'c-amber', title: 'BDC en attente de signature' },
            }[bdcView];
            return (
              <>
                <TopList rows={bdc[bdcView].detail} color={meta.color} />
                <div
                  className="see-all linky"
                  onClick={() => openModal(meta.title, bdc[bdcView].detail, false, meta.color)}
                >
                  ⤢ Voir tout
                </div>
              </>
            );
          })()}
        </div>

        {/* ===== RANGÉE CLASSEMENTS ===== */}
        <div className="tile col-3">
          <TileHead dotClass="bg-orange" title="Propals" />
          <div
            className="subsec clickable-zone"
            onClick={() => openModal('Propals Pistes par commercial', propals.detail, false, 'c-orange')}
          >
            <div className="subsec-head">
              <span>Pistes</span>
              <b className="c-orange">{propals.total}</b>
            </div>
            <TopList rows={propals.detail} color="c-orange" max={4} />
          </div>
          <div
            className="subsec clickable-zone"
            onClick={() => openModal('Propositions Comptes par commercial', propalsComptes.detail, false, 'c-amber')}
          >
            <div className="subsec-head">
              <span>Comptes</span>
              <b className="c-amber">{propalsComptes.total}</b>
            </div>
            <TopList rows={propalsComptes.detail} color="c-amber" max={5} />
          </div>
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('R1 pris par commercial', rdvB.r1.detail, false, 'c-amber')}>
          <TileHead dotClass="bg-amber" title="R1 pris par sales" clickable />
          <TopList rows={rdvB.r1.detail} color="c-amber" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('R2 pris par commercial', rdvB.r2.detail, false, 'c-amber')}>
          <TileHead dotClass="bg-amber" title="R2 pris par sales" clickable />
          <TopList rows={rdvB.r2.detail} color="c-amber" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('RDV SalesForge par commercial', sf.detail, false, 'c-bluer2')}>
          <TileHead dotClass="bg-bluer2" title={`SalesForge · ${sf.total} RDV`} clickable />
          <TopList rows={sf.detail} color="c-bluer2" />
        </div>
      </div>

      <div className="foot">
        <span className="foot-brand">OPENMEDIAS</span>
        <span className="foot-sub">Live · Le robot trop rigolo 🤖 · {new Date().getFullYear()}</span>
      </div>

      {showEmail && (
        <div className="modal-overlay" onClick={() => !emailing && setShowEmail(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">Envoyer cette vue par mail</span>
              <button className="modal-close" onClick={() => !emailing && setShowEmail(false)} aria-label="Fermer">✕</button>
            </div>
            <div className="modal-body">
              <div className="adm-label">Période envoyée</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{rangeLabel}</div>

              <div className="adm-label">Destinataires</div>
              <div className="adm-chips">
                <button type="button" className="adm-chip" onClick={addMyself} disabled={emailing}>
                  + Moi-même
                </button>
              </div>
              <textarea
                className="adm-input"
                rows={3}
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="prenom@openmedias.com, autre@…"
                autoFocus
                disabled={emailing}
              />

              <div className="adm-actions">
                <button className="adm-btn ghost" onClick={() => setShowEmail(false)} disabled={emailing}>
                  Annuler
                </button>
                <button className="adm-btn primary" onClick={submitEmail} disabled={emailing || !emailTo.trim()}>
                  {emailing ? 'Envoi…' : 'Envoyer'}
                </button>
              </div>

              {emailMsg && (
                <div className={`adm-status ${emailMsg.startsWith('Mail envoyé') ? 'ok' : 'ko'}`}>
                  {emailMsg}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AdminConsole
        open={showAdmin}
        password={password}
        onClose={() => setShowAdmin(false)}
        period={period}
        rangeLabel={rangeLabel}
      />

      {showTv && (
        <TvView
          password={password}
          hiddenSales={hiddenSales}
          onClose={() => setShowTv(false)}
        />
      )}

      <SettingsModal
        open={showSettings}
        hidden={hidden}
        onToggle={toggleHidden}
        onShowAll={() => setHiddenSales([])}
        onClose={() => setShowSettings(false)}
      />

      <DetailModal
        open={!!modal}
        title={modal?.title}
        rows={modal?.rows || []}
        isAmount={modal?.isAmount}
        accent={modal?.accent}
        onClose={() => setModal(null)}
      />
    </div>
  );
}

// ---------- ROOT ----------
export default function App() {
  const [password, setPassword] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('om_theme') || 'dark');

  useEffect(() => {
    const saved = sessionStorage.getItem('om_pw');
    if (saved) setPassword(saved);
  }, []);

  // Applique le thème sur <html> et mémorise la préférence
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('om_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const handleSuccess = useCallback((pw) => { sessionStorage.setItem('om_pw', pw); setPassword(pw); }, []);
  const handleLogout = useCallback(() => { sessionStorage.removeItem('om_pw'); setPassword(null); }, []);

  if (!password) return <Login onSuccess={handleSuccess} />;
  return <Dashboard password={password} onLogout={handleLogout} theme={theme} onToggleTheme={toggleTheme} />;
}

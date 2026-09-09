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

// ---------- MODE ÉDITION — blocs du dashboard réorganisables ----------
// Chaque "bloc" regroupe plusieurs tuiles existantes (pas tuile par tuile,
// pour rester gérable) — ordre mémorisé par navigateur (localStorage), pas
// de backend : c'est une préférence d'affichage personnelle, pas une donnée
// métier partagée.
const DEFAULT_BLOCK_ORDER = ['hero', 'money', 'ca12mois', 'activite', 'classements', 'objectifs', 'newsletter', 'synthese'];
// Vue commercial (comptes role='commercial', cf. isRestrictedCommercial) : on
// masque tout ce qui suit "CA - 12 mois glissants", sauf le tunnel de
// conversion (qui reste affiché, sans le podium, via le contenu du bloc
// "synthese" — cf. plus bas).
const HIDDEN_BLOCKS_FOR_COMMERCIAL = ['activite', 'classements', 'objectifs', 'newsletter'];
const BLOCK_LABELS = {
  hero: 'KPI principaux',
  money: 'CA + Signatures',
  ca12mois: 'CA — 12 mois glissants',
  activite: 'Activité (Calls, RDV pris, BDC)',
  classements: 'Classements (Propals, RDV, SalesForge)',
  objectifs: 'Objectifs individuels',
  newsletter: 'Newsletters',
  synthese: 'Synthèse semaine (tunnel + podium)',
};
const BLOCK_ORDER_STORAGE_KEY = 'om_block_order';

// ---------- AUTH (fusion OpenDashboard / OpenPlanning) ----------
// `cred` (anciennement une simple string "password") est désormais un objet :
//   { mode: 'legacy', password }                       — mot de passe unique (filet de sécurité, accès admin complet)
//   { mode: 'commercial', commercialId, nom, isAdmin }  — compte individuel (même compte que sur le planning)
// credHeaders() construit les headers d'auth adaptés, pour ne pas avoir à
// dupliquer cette logique à chaque appel fetch.
function credHeaders(cred, extra = {}) {
  if (!cred) return extra;
  if (cred.mode === 'commercial') return { ...extra, 'x-commercial-id': String(cred.commercialId) };
  return { ...extra, 'x-dashboard-password': cred.password };
}
function isAdminCred(cred) {
  if (!cred) return false;
  return cred.mode === 'legacy' ? true : !!cred.isAdmin;
}

// ---------- LOGIN ----------
function Login({ onSuccess }) {
  const [mode, setMode] = useState('commercial'); // 'commercial' (par défaut) ou 'legacy'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Repliés dans un seul disclosure (voir plus bas) : avant, le switch
  // "Mot de passe unique (admin)" (bouton souligné) et le lien "Accès édito
  // par code" (lien souligné à l'opacité différente) étaient posés l'un sous
  // l'autre sans traitement commun, comme deux échappatoires sans lien visuel.
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  // Mot de passe oublié : mini-formulaire (email seul) plutôt qu'un écran à
  // part — endpoint monté sous /planning (routeur planning/backend/router.js,
  // partagé avec les comptes du planning), d'où le chemin absolu ci-dessous
  // au lieu du chemin relatif 'api/...' utilisé pour les routes propres à ce
  // serveur racine.
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);

  const submitForgot = async () => {
    if (!forgotEmail.trim()) { setForgotMsg('Email requis.'); return; }
    setForgotLoading(true); setForgotMsg('');
    try {
      const res = await fetch('/planning/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      // Avant : res.ok n'était jamais vérifié, donc une erreur (400, ou 429
      // si la limite de fréquence est atteinte) affichait quand même le
      // message de succès générique (data.message undefined -> fallback)
      // au lieu de prévenir l'utilisateur que sa demande a été rejetée.
      setForgotMsg(!res.ok
        ? (data.error || 'Une erreur est survenue.')
        : (data.message || 'Si un compte existe avec cet email, un lien de réinitialisation vient de lui être envoyé.'));
    } catch {
      setForgotMsg('Erreur réseau.');
    } finally { setForgotLoading(false); }
  };

  const submit = async () => {
    setLoading(true); setError('');
    try {
      const body = mode === 'legacy' ? { password } : { email, password };
      const res = await fetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && mode === 'legacy') {
        onSuccess({ mode: 'legacy', password });
      } else if (res.ok) {
        onSuccess({ mode: 'commercial', commercialId: data.commercialId, nom: data.nom, isAdmin: !!data.isAdmin, role: data.role, teamId: data.teamId });
      } else {
        setError(data.error || 'Identifiants incorrects');
      }
    } catch {
      setError('Erreur de connexion au serveur');
    } finally { setLoading(false); }
  };

  if (showForgot) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="brand-mark" style={{ marginBottom: 14 }} />
          <div className="login-eyebrow">OpenMedias · Sales Dashboard</div>
          <div className="login-title">Mot de passe<br />oublié</div>
          <input
            className="login-input" type="email" placeholder="Email du compte"
            value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitForgot()} autoFocus
          />
          <button className="login-btn" onClick={submitForgot} disabled={forgotLoading}>
            {forgotLoading ? 'Envoi…' : 'Envoyer le lien'}
          </button>
          {forgotMsg && <div className="login-hint">{forgotMsg}</div>}
          <button
            className="login-link-btn"
            onClick={() => { setShowForgot(false); setForgotMsg(''); setForgotEmail(''); }}
            style={{ marginTop: 14 }}
          >
            ← Retour à la connexion
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-mark" style={{ marginBottom: 14 }} />
        <div className="login-eyebrow">OpenMedias · Sales Dashboard</div>
        <div className="login-title">Performance<br />Commerciale</div>
        {mode === 'commercial' ? (
          <>
            <input
              className="login-input" type="email" placeholder="Email"
              value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus
            />
            <input
              className="login-input" type="password" placeholder="Mot de passe"
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              style={{ marginTop: 8 }}
            />
          </>
        ) : (
          <input
            className="login-input" type="password" placeholder="Mot de passe"
            value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus
          />
        )}
        <button className="login-btn" onClick={submit} disabled={loading}>
          {loading ? 'Connexion…' : 'Accéder au dashboard'}
        </button>
        {error && <div className="login-error">{error}</div>}
        {mode === 'commercial' && (
          <button
            className="login-link-btn"
            onClick={() => { setShowForgot(true); setError(''); }}
            style={{ marginTop: 12 }}
          >
            Mot de passe oublié ?
          </button>
        )}
        {/* Options de secours (mot de passe unique admin, ancien accès par
            code) repliées dans un seul disclosure au même traitement visuel
            — avant, un bouton souligné et un lien souligné à une autre
            opacité cohabitaient sans rien qui les présente comme la même
            catégorie "solutions de repli". */}
        <button
          className="login-link-btn"
          onClick={() => setShowMoreOptions((o) => !o)}
          style={{ marginTop: mode === 'commercial' ? 6 : 12 }}
        >
          Autres options de connexion {showMoreOptions ? '▴' : '▾'}
        </button>
        {showMoreOptions && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              className="login-link-btn"
              onClick={() => { setMode((m) => (m === 'commercial' ? 'legacy' : 'commercial')); setError(''); }}
            >
              {mode === 'commercial' ? 'Mot de passe unique (admin)' : 'Compte commercial (email)'}
            </button>
            <a className="login-link-btn" href="/planning?pin=1">
              Accès édito par code (ancien système)
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- MODALE détail ----------
function DetailModal({ open, title, rows, isAmount, accent, onClose, cmpRows, extraCols }) {
  if (!open) return null;
  const max = Math.max(1, ...rows.map((r) => (isAmount ? r.amount : r.count)));
  // Index comparaison par nom pour lookup O(1)
  const cmpMap = {};
  if (cmpRows && cmpRows.length) {
    cmpRows.forEach((r) => { cmpMap[r.name] = isAmount ? (r.amount || 0) : (r.count || 0); });
  }
  const hasCmp = Object.keys(cmpMap).length > 0;
  const pctDelta = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
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
              const barPct = Math.round((v / max) * 100);
              const prev = hasCmp ? (cmpMap[r.name] ?? null) : null;
              const delta = prev !== null ? pctDelta(v, prev) : null;
              return (
                <div className="mrow" key={i}>
                  <div className="mrow-rank">{i + 1}</div>
                  <div className="mrow-main">
                    <div className="mrow-top">
                      <span className="mrow-name">{r.name}</span>
                      <span className={`mrow-val ${v === 0 ? 'zero' : accent}`}>
                        {isAmount ? `${fmt(r.amount)} €` : r.count}
                      </span>
                      {delta !== null && (
                        <span className={`mrow-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
                          {delta > 0 ? '▲' : delta < 0 ? '▼' : '•'}{Math.abs(delta)}%
                        </span>
                      )}
                    </div>
                    {extraCols && extraCols.length > 0 && (
                      <div className="mrow-extra">
                        {extraCols.map((c, ci) => (
                          <span className="mrow-extra-item" key={ci}>
                            {c.label} : <b>{c.render(r)}</b>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mrow-bar-bg">
                      <div className={`mrow-bar ${accent}-bg`} style={{ width: `${barPct}%` }} />
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

// Podium à 3 colonnes (Calls / RDV pris / CA) sur la semaine en cours.
// `anonymized` masque les noms (utile sur un écran public, cf. TvView) en les
// remplaçant par leur rang — les valeurs restent affichées, seule l'identité change.
const MEDALS = ['🥇', '🥈', '🥉'];
function LeaderboardColumn({ title, rows, isAmount, color, anonymized }) {
  const top = (rows || []).filter((r) => (isAmount ? r.amount : r.count) > 0).slice(0, 3);
  return (
    <div className="lb-col">
      <div className="lb-col-title">{title}</div>
      {top.length === 0 ? (
        <div className="empty">Aucune donnée</div>
      ) : (
        top.map((r, i) => (
          <div className="lb-row" key={i}>
            <span className="lb-medal">{MEDALS[i]}</span>
            <span className="lb-name">{anonymized ? `Commercial #${i + 1}` : r.name}</span>
            <span className={`lb-val ${color}`}>{isAmount ? `${fmt(r.amount)} €` : r.count}</span>
          </div>
        ))
      )}
    </div>
  );
}
// Funnel v3 : vrai entonnoir centré — barres de largeur proportionnelle à la
// 1ère étape, centrées (label au-dessus, valeur dans la barre), taux de
// passage en pillule entre étapes + conversion globale en pied. Chaque stage
// peut fournir `text` (couleur du chiffre) pour les barres claires.
function ConversionFunnel({ stages }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  const first = stages[0]?.value || 0;
  const last = stages[stages.length - 1]?.value || 0;
  const globalRate = first > 0 ? Math.round((last / first) * 1000) / 10 : null;
  return (
    <div className="funnel-v3">
      {stages.map((s, i) => (
        <React.Fragment key={s.label}>
          {i > 0 && (
            <div className="funnel-v3-rate">
              <span className="funnel-v3-arrow">▼</span>
              <span className={`funnel-rate ${s.rate === null ? '' : s.rate >= 50 ? 'up' : s.rate >= 20 ? 'flat' : 'down'}`}>
                {s.rate === null ? '—' : `${s.rate}%`}
              </span>
            </div>
          )}
          <div className="funnel-v3-stage">
            <div className="funnel-v3-label">{s.label}</div>
            <div
              className="funnel-v3-bar"
              style={{
                width: `${Math.max(9, Math.round((s.value / max) * 100))}%`,
                background: `linear-gradient(180deg, rgba(255,255,255,0.16), rgba(0,0,0,0.14)), ${s.color}`,
              }}
            >
              <span className="funnel-v3-val" style={{ color: s.text || '#fff' }}>{fmt(s.value)}</span>
            </div>
          </div>
        </React.Fragment>
      ))}
      {globalRate !== null && (
        <div className="funnel-v3-foot">
          Conversion globale {stages[0]?.label} → {stages[stages.length - 1]?.label} : <strong>{globalRate}%</strong>
        </div>
      )}
    </div>
  );
}

function Leaderboard({ callsDetail, rdvDetail, revenueDetail, anonymized }) {
  return (
    <div className="lb-grid">
      <LeaderboardColumn title="📞 Calls" rows={callsDetail} isAmount={false} color="c-blue" anonymized={anonymized} />
      <LeaderboardColumn title="📅 RDV pris" rows={rdvDetail} isAmount={false} color="c-amber" anonymized={anonymized} />
      <LeaderboardColumn title="💰 CA" rows={revenueDetail} isAmount color="c-green" anonymized={anonymized} />
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

// L'ancienne "Console admin cachée" (Ctrl/Cmd+Maj+A) a été retirée : elle ne
// faisait plus que dupliquer le bloc "OpenDashboard — Reporting automatique"
// déjà présent, VISIBLE, dans Paramètres planning (dash-admin-card), suite à
// la fusion des deux backends admin. Un même réglage ne doit avoir qu'un seul
// endroit pour le changer — sans quoi les deux copies risquent de diverger
// (l'une montrée, l'autre éditée par erreur). Accès désormais unique via le
// bouton "⚙️ Paramètres" (visible pour les comptes admin, cf. topbar).

// ---------- PARAMÈTRES ADMIN (équipes + sales visibles) ----------
function SettingsModal({ open, hidden, onToggle, onShowAll, onClose, password, teams = [], onTeamsChanged, objectifs = [], onObjectifsChanged, allSales = ALL_SALES }) {
  const [newTeamLabel, setNewTeamLabel] = useState('');
  const [openTeamId, setOpenTeamId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!open) return null;

  const authHeaders = credHeaders(password, { 'Content-Type': 'application/json' });

  const run = async (fn, { skipTeamsReload } = {}) => {
    setBusy(true); setErr('');
    try {
      await fn();
      if (!skipTeamsReload) onTeamsChanged?.();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const saveObjectif = (commercialId, currentValue, rawInput) => {
    const n = Math.max(0, parseInt(String(rawInput).replace(/[^\d]/g, ''), 10) || 0);
    if (n === currentValue) return; // rien à sauvegarder
    run(async () => {
      const r = await fetch(`api/admin/objectifs/${commercialId}`, {
        method: 'PATCH', headers: authHeaders, body: JSON.stringify({ monthlyObjective: n }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erreur');
      onObjectifsChanged?.();
    }, { skipTeamsReload: true });
  };

  const createTeam = () => {
    const label = newTeamLabel.trim();
    if (!label) return;
    run(async () => {
      const r = await fetch('api/admin/teams', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ label, members: [] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erreur');
      setNewTeamLabel('');
    });
  };

  const renameTeam = (id, currentLabel) => {
    const label = window.prompt('Nouveau nom pour cette équipe :', currentLabel);
    if (label === null) return;
    const trimmed = label.trim();
    if (!trimmed || trimmed === currentLabel) return;
    run(async () => {
      const r = await fetch(`api/admin/teams/${id}`, {
        method: 'PATCH', headers: authHeaders, body: JSON.stringify({ label: trimmed }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erreur');
    });
  };

  const deleteTeam = (id, label) => {
    if (!window.confirm(`Supprimer l'équipe "${label}" ? Les sales ne sont pas supprimés, juste détachés de cette équipe.`)) return;
    run(async () => {
      const r = await fetch(`api/admin/teams/${id}`, { method: 'DELETE', headers: authHeaders });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Erreur'); }
    });
  };

  const toggleMember = (team, name) => {
    const members = team.members.includes(name)
      ? team.members.filter((m) => m !== name)
      : [...team.members, name];
    run(async () => {
      const r = await fetch(`api/admin/teams/${team.id}`, {
        method: 'PATCH', headers: authHeaders, body: JSON.stringify({ members }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erreur');
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">⚙️ Paramètres</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          <div className="set-section-title">Équipes</div>
          {err && <div className="set-error">{err}</div>}
          {teams.map((t) => (
            <div className="set-team" key={t.id}>
              <div className="set-team-head">
                <span className="set-team-label">{t.label}</span>
                <span className="set-team-actions">
                  <button className="set-team-btn" onClick={() => setOpenTeamId(openTeamId === t.id ? null : t.id)} disabled={busy} title="Voir/éditer les membres">
                    {t.members.length} membre{t.members.length > 1 ? 's' : ''} {openTeamId === t.id ? '▲' : '▾'}
                  </button>
                  <button className="set-team-btn set-team-icon" onClick={() => renameTeam(t.id, t.label)} disabled={busy} title="Renommer">✎</button>
                  <button className="set-team-btn set-team-icon set-team-danger" onClick={() => deleteTeam(t.id, t.label)} disabled={busy} title="Supprimer">✕</button>
                </span>
              </div>
              {openTeamId === t.id && (
                <div className="set-team-members">
                  {allSales.map((s) => (
                    <label className="set-row" key={s}>
                      <span className="set-name">{s}</span>
                      <input
                        type="checkbox"
                        className="set-check"
                        checked={t.members.includes(s)}
                        onChange={() => toggleMember(t, s)}
                        disabled={busy}
                      />
                      <span className="set-switch" />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="set-team-new">
            <input
              className="set-team-input"
              placeholder="Nouvelle équipe…"
              value={newTeamLabel}
              onChange={(e) => setNewTeamLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createTeam(); }}
              disabled={busy}
            />
            <button className="set-team-btn set-team-add" onClick={createTeam} disabled={busy || !newTeamLabel.trim()}>
              + Ajouter
            </button>
          </div>

          <div className="set-sep" />
          <div className="set-section-title">Sales visibles</div>
          <div className="set-hint">
            Désactive un commercial pour le masquer de tout le dashboard
            (listes, graphes et totaux recalculés). Réglage mémorisé sur ce navigateur.
          </div>
          {hidden.size > 0 && (
            <button className="set-showall" onClick={onShowAll}>
              Tout réafficher ({hidden.size} masqué{hidden.size > 1 ? 's' : ''})
            </button>
          )}
          {allSales.map((s) => (
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

          <div className="set-sep" />
          <div className="set-section-title">Objectifs mensuels (CA)</div>
          <div className="set-hint">
            Objectif de chiffre d'affaires par commercial pour le mois en cours —
            affiché en jauge sur la tuile "Objectifs du mois en cours" du dashboard.
            0 ou vide = pas d'objectif (la jauge ne s'affiche pas pour cette personne).
          </div>
          {objectifs.length === 0 && <div className="empty">Aucun compte commercial aligné au roster</div>}
          {objectifs.map((o) => (
            <div className="set-row" style={{ cursor: 'default' }} key={o.commercialId}>
              <span className="set-name">{o.displayName}</span>
              <input
                type="number"
                min="0"
                step="500"
                className="set-obj-input"
                defaultValue={o.monthlyObjective || ''}
                placeholder="0 €"
                disabled={busy}
                onBlur={(e) => saveObjectif(o.commercialId, o.monthlyObjective, e.target.value)}
              />
            </div>
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
// Auto-refresh du dashboard "normal" (pas la vue TV) : les caches serveur
// (rawDataCache.js) ont un TTL de 5 min sur les données volatiles (Leads
// Working, enveloppes DocuSign en attente) — inutile de retaper plus souvent,
// ça ne ferait que re-render sans nouvelle donnée réelle.
const DASHBOARD_REFRESH_MS = 5 * 60 * 1000;

// Statut de signature de la 3e colonne. 'ok' = a signé cette semaine.
const SIGN_STATUS = {
  ok: { emoji: '🔥', cls: 'st-ok' },
  1: { emoji: '😐', cls: 'st-1' },
  2: { emoji: '😕', cls: 'st-2' },
  3: { emoji: '😟', cls: 'st-3' },
  4: { emoji: '😰', cls: 'st-4' },
  5: { emoji: '💀', cls: 'st-5' },
};

function TvView({ password, hiddenSales, onClose, teams = TEAMS }) {
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
        fetch('api/dashboard?preset=today', { headers: credHeaders(password) }),
        fetch('api/dashboard?preset=this_week', { headers: credHeaders(password) }),
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
  const teamCards = teams.map((t, i) => ({
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

// ---------- HELPER : format date courte ----------
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ---------- RATE BADGE (open/click rate coloré) ----------
function RateBadge({ value, type }) {
  const getClass = () => {
    if (type === 'open') {
      if (value >= 30) return 'nl-rate-hi';
      if (value >= 15) return 'nl-rate-mid';
      return 'nl-rate-lo';
    }
    if (type === 'click') {
      if (value >= 5) return 'nl-rate-hi';
      if (value >= 2) return 'nl-rate-mid';
      return 'nl-rate-lo';
    }
    if (type === 'unsub') {
      if (value < 0.3) return 'nl-rate-hi';
      if (value < 0.8) return 'nl-rate-mid';
      return 'nl-rate-lo';
    }
    return '';
  };
  return <span className={`nl-rate-badge ${getClass()}`}>{value.toFixed(1)}%</span>;
}

// ---------- MODAL : liste des campagnes NL EXT ----------
function NlCampaignsModal({ campaigns, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal nl-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">📧 Newsletters EXT · détail par campagne</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          {campaigns.length === 0 ? (
            <div className="empty">Aucune newsletter EXT sur la période</div>
          ) : (
            <div className="nl-camp-list">
              <div className="nl-camp-header">
                <span className="nl-camp-date">Date</span>
                <span className="nl-camp-title-col">Campagne</span>
                <span className="nl-camp-metric">Envoyés</span>
                <span className="nl-camp-metric">Ouvertures</span>
                <span className="nl-camp-metric">Clics</span>
                <span className="nl-camp-metric">Désinscrits</span>
              </div>
              {campaigns.map((c) => (
                <div className="nl-camp-row" key={c.id}>
                  <span className="nl-camp-date">{fmtDate(c.sentAt)}</span>
                  <span className="nl-camp-title-col" title={c.subject || c.title}>{c.title}</span>
                  <span className="nl-camp-metric nl-sent">{fmt(c.sent)}</span>
                  <span className="nl-camp-metric">
                    <RateBadge value={c.openRate} type="open" />
                    <span className="nl-abs">({fmt(c.opened)})</span>
                  </span>
                  <span className="nl-camp-metric">
                    <RateBadge value={c.clickRate} type="click" />
                    <span className="nl-abs">({fmt(c.clicked)})</span>
                  </span>
                  <span className="nl-camp-metric">
                    <RateBadge value={c.unsubRate} type="unsub" />
                    <span className="nl-abs">({fmt(c.unsubscribed)})</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- SECTION NEWSLETTER EXT ----------
// Widget 1 : KPIs globaux Mailjet (col-5) + widget 2 : RDV NL par manager (col-7)
function NewsletterSection({ nlData, nlLoading, rangeLabel, onOpenCampaigns }) {
  const NL_MANAGERS = ['Lisa Neveu', 'Paul Jouannet', 'David CHEA', 'Quentin PUREN'];
  const MANAGER_COLORS = {
    'Lisa Neveu': { accent: '#3B82F6', bg: 'rgba(59,130,246,0.12)', label: 'Lisa' },
    'Paul Jouannet': { accent: '#22C55E', bg: 'rgba(34,197,94,0.12)', label: 'Paul' },
    'David CHEA': { accent: '#F97316', bg: 'rgba(249,115,22,0.12)', label: 'David' },
    'Quentin PUREN': { accent: '#FBBF24', bg: 'rgba(251,191,36,0.12)', label: 'Quentin' },
  };

  const totals = nlData?.newsletters?.totals || {};
  const campaigns = nlData?.newsletters?.campaigns || [];
  const nlRdvDetail = nlData?.nlRdv?.detail || [];
  const nlRdvTotal = nlData?.nlRdv?.total || 0;
  const campCount = totals.count || 0;

  const rdvMap = {};
  nlRdvDetail.forEach((r) => { rdvMap[r.name] = r.count; });

  return (
    <>
      {/* Widget 1 — KPIs NL globaux */}
      <div className="tile col-5 clickable nl-kpi-tile" onClick={onOpenCampaigns}>
        <TileHead dotClass="bg-blue" title={`Newsletters EXT · ${campCount} campagne${campCount > 1 ? 's' : ''} · ${rangeLabel}`} clickable />
        {nlLoading && !nlData ? (
          <div className="empty">Chargement…</div>
        ) : campCount === 0 ? (
          <div className="empty">Aucune NL EXT sur la période</div>
        ) : (
          <div className="nl-kpis">
            <div className="nl-kpi-card">
              <div className="nl-kpi-val">{fmt(totals.sent || 0)}</div>
              <div className="nl-kpi-label">Envoyés</div>
            </div>
            <div className="nl-kpi-card accent-open">
              <div className="nl-kpi-val">{(totals.openRate || 0).toFixed(1)}<span className="nl-pct">%</span></div>
              <div className="nl-kpi-label">Open rate</div>
              <div className="nl-kpi-sub">{fmt(totals.opened || 0)} ouvertures</div>
            </div>
            <div className="nl-kpi-card accent-click">
              <div className="nl-kpi-val">{(totals.clickRate || 0).toFixed(1)}<span className="nl-pct">%</span></div>
              <div className="nl-kpi-label">Click rate</div>
              <div className="nl-kpi-sub">{fmt(totals.clicked || 0)} clics</div>
            </div>
            <div className="nl-kpi-card accent-unsub">
              <div className="nl-kpi-val">{(totals.unsubRate || 0).toFixed(1)}<span className="nl-pct">%</span></div>
              <div className="nl-kpi-label">Désinscriptions</div>
              <div className="nl-kpi-sub">{fmt(totals.unsubscribed || 0)} contacts</div>
            </div>
          </div>
        )}
        {campCount > 0 && (
          <div className="nl-see-detail">⤢ Voir le détail par campagne ({campCount})</div>
        )}
      </div>

      {/* Widget 2 — RDV pris via NL par manager */}
      <div className="tile col-7">
        <TileHead dotClass="bg-green" title={`RDV pris via Newsletter · ${rangeLabel}`} />
        {nlLoading && !nlData ? (
          <div className="empty">Chargement…</div>
        ) : (
          <div className="nl-rdv-grid">
            {NL_MANAGERS.map((name) => {
              const col = MANAGER_COLORS[name];
              const count = rdvMap[name] || 0;
              return (
                <div className="nl-rdv-card" key={name} style={{ '--nl-accent': col.accent, '--nl-bg': col.bg }}>
                  <div className="nl-rdv-count">{count}</div>
                  <div className="nl-rdv-name">{col.label}</div>
                  <div className="nl-rdv-label">RDV NL</div>
                </div>
              );
            })}
            <div className="nl-rdv-total-card">
              <div className="nl-rdv-count nl-rdv-total-count">{nlRdvTotal}</div>
              <div className="nl-rdv-name">Total</div>
              <div className="nl-rdv-label">tous managers</div>
            </div>
          </div>
        )}
        {nlData?.errors?.calendly && (
          <div className="nl-err">⚠ Calendly : {nlData.errors.calendly}</div>
        )}
      </div>
    </>
  );
}


// ---------- DASHBOARD ----------
// ---------- "MA SEMAINE" — vue perso du commercial connecté ----------
function MaSemaineModal({ open, onClose, nom, callsTotal, propalsTotal, propalsAmount, upcoming }) {
  if (!open) return null;
  const fmtDateTime = (ms) => new Date(ms).toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">📅 Ma semaine{nom ? ` — ${nom.split(' ')[0]}` : ''}</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          <div className="lb-grid" style={{ marginBottom: 16 }}>
            <div className="lb-col">
              <div className="lb-col-title">📞 Calls cette semaine</div>
              <div className="funnel-stage-val" style={{ color: '#3B82F6' }}>{fmt(callsTotal)}</div>
            </div>
            <div className="lb-col">
              <div className="lb-col-title">📄 Propals actives</div>
              <div className="funnel-stage-val" style={{ color: '#F97316' }}>{fmt(propalsTotal)}</div>
              <div className="kpi-sub" style={{ marginTop: 2 }}>{fmt(propalsAmount)} € estimés</div>
            </div>
          </div>
          <div className="set-section-title">Mes RDV à venir (7 prochains jours)</div>
          {upcoming.length === 0 ? (
            <div className="empty">Aucun RDV à venir sur cette période</div>
          ) : (
            upcoming.map((r, i) => (
              <div className="mrow" key={i}>
                <div className="mrow-rank">{r.isR2 ? 'R2' : 'R1'}</div>
                <div className="mrow-main">
                  <div className="mrow-top">
                    <span className="mrow-name">{r.name || 'Rendez-vous'}</span>
                    <span className="mrow-val c-blue">{fmtDateTime(r.at)}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Dashboard({ password, onLogout, theme, onToggleTheme }) {
  const isAdmin = isAdminCred(password);
  // Rôle du compte connecté, pour adapter les filtres visibles à ce qu'il peut
  // réellement voir — le serveur ne renvoie déjà que ses propres données à un
  // commercial (ou celles de son équipe à un manager), donc lui proposer de
  // filtrer sur d'autres collègues/équipes n'a pas de sens et ne fait que
  // donner l'impression d'un dashboard cassé (résultat vide).
  const myAccountRole = password?.mode === 'commercial' ? password.role : null; // null = legacy/admin, vue complète
  const isRestrictedCommercial = myAccountRole === 'commercial';
  const isRestrictedManager = myAccountRole === 'manager';
  const showCrossTeamFilters = !isRestrictedCommercial && !isRestrictedManager;
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
  const [showTv, setShowTv] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false); // menu ☰ mobile (filtres/actions du header)
  const [nlData, setNlData] = useState(null);
  const [nlLoading, setNlLoading] = useState(false);
  const [nlModal, setNlModal] = useState(null); // 'campaigns' | null
  const [teams, setTeams] = useState(TEAMS); // liste dynamique (créer/renommer/supprimer via ⚙️ Paramètres)
  const loadTeams = useCallback(async () => {
    try {
      const r = await fetch('api/teams', { headers: credHeaders(password) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.teams)) setTeams(d.teams);
      }
    } catch { /* silencieux : on garde la dernière liste connue */ }
  }, [password]);
  useEffect(() => { loadTeams(); }, [loadTeams]);

  // Roster (liste "Sales" + qui est manager) : dérivé côté serveur en direct
  // de commercial_users (cf. server/roster.js et /api/admin/roster) — un
  // nouveau commercial apparaît ici dès que son compte existe, sans jamais
  // retoucher client/src/teams.js. ALL_SALES/MANAGERS n'y restent qu'en
  // valeur de repli le temps du premier chargement.
  const [allSales, setAllSales] = useState(ALL_SALES);
  const [managersDynamic, setManagersDynamic] = useState(MANAGERS);
  const loadRoster = useCallback(async () => {
    try {
      const r = await fetch('api/admin/roster', { headers: credHeaders(password) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.names) && d.names.length) setAllSales(d.names);
        if (Array.isArray(d.managers)) setManagersDynamic(d.managers);
      }
    } catch { /* silencieux : on garde la dernière liste connue */ }
  }, [password]);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  // Objectifs individuels de CA mensuel (planning.db, cf. server/index.js /api/objectifs)
  const [objectifs, setObjectifs] = useState([]); // [{ commercialId, displayName, monthlyObjective }]
  const loadObjectifs = useCallback(async () => {
    try {
      const r = await fetch('api/objectifs', { headers: credHeaders(password) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d)) setObjectifs(d);
      }
    } catch { /* silencieux */ }
  }, [password]);
  useEffect(() => { loadObjectifs(); }, [loadObjectifs]);

  // CA mensuel sur 12 mois glissants (graphique d'évolution, indépendant de la
  // période sélectionnée en haut de page — cf. server /api/revenue-by-month).
  const [monthlyRevenue, setMonthlyRevenue] = useState([]);
  const loadMonthlyRevenue = useCallback(async () => {
    try {
      const r = await fetch('api/revenue-by-month?months=12', { headers: credHeaders(password) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.months)) setMonthlyRevenue(d.months);
      }
    } catch { /* silencieux */ }
  }, [password]);
  useEffect(() => { loadMonthlyRevenue(); }, [loadMonthlyRevenue]);

  // Leaderboard hebdo : toujours "cette semaine", indépendant du filtre de
  // période principal (même logique que TvView, qui fetch déjà preset=this_week).
  const [weekData, setWeekData] = useState(null);
  const [lbAnonymized, setLbAnonymized] = useState(false);
  const loadWeekData = useCallback(async () => {
    try {
      const r = await fetch('api/dashboard?preset=this_week', { headers: credHeaders(password) });
      if (r.ok) setWeekData(await r.json());
    } catch { /* silencieux */ }
  }, [password]);
  useEffect(() => { loadWeekData(); }, [loadWeekData]);

  // "Ma semaine" : vue perso, réservée aux comptes commerciaux individuels
  // (calls/propals viennent de weekData, déjà scopé côté serveur ; seuls les
  // RDV à venir datés sont une donnée dédiée, cf. /api/mes-rdv-a-venir).
  const [showMaSemaine, setShowMaSemaine] = useState(false);
  const [mesRdv, setMesRdv] = useState([]);
  const loadMesRdv = useCallback(async () => {
    if (!isRestrictedCommercial) return;
    try {
      const r = await fetch('api/mes-rdv-a-venir?days=7', { headers: credHeaders(password) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.upcoming)) setMesRdv(d.upcoming);
      }
    } catch { /* silencieux */ }
  }, [password, isRestrictedCommercial]);
  useEffect(() => { loadMesRdv(); }, [loadMesRdv]);

  // Nettoyage unique d'un ancien mécanisme : la clé localStorage
  // 'om_admin_settings' n'est plus écrite nulle part, mais un useEffect la
  // RE-POSTAIT au serveur à chaque chargement pour "resynchroniser" les
  // réglages (vestige de l'époque où la mémoire serveur était volatile sur
  // Render free). Résultat : un vieux snapshot présent dans le navigateur
  // écrasait silencieusement les réglages persistés en SQLite — notamment
  // monthlyRevenueObjective, impossible à changer durablement. Les réglages
  // vivent maintenant dans la base persistée (adminSettings.js), la source
  // de vérité est le serveur : on supprime juste la clé périmée.
  useEffect(() => {
    try { localStorage.removeItem('om_admin_settings'); } catch { /* noop */ }
  }, []);
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

  // ---- Mode édition : réorganiser les blocs du dashboard (drag & drop natif) ----
  const [editMode, setEditMode] = useState(false);
  const [blockOrder, setBlockOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(BLOCK_ORDER_STORAGE_KEY) || 'null');
      if (Array.isArray(saved) && saved.length) {
        // Ne garde que les blocs connus (protège contre un renommage futur),
        // et ajoute à la fin tout nouveau bloc apparu depuis le dernier réglage.
        const known = new Set(DEFAULT_BLOCK_ORDER);
        const kept = saved.filter((id) => known.has(id));
        const missing = DEFAULT_BLOCK_ORDER.filter((id) => !kept.includes(id));
        return [...kept, ...missing];
      }
    } catch { /* ignore, on retombe sur l'ordre par défaut */ }
    return DEFAULT_BLOCK_ORDER;
  });
  useEffect(() => {
    localStorage.setItem(BLOCK_ORDER_STORAGE_KEY, JSON.stringify(blockOrder));
  }, [blockOrder]);

  // Vue commercial : retire les blocs masqués de l'ordre affiché (l'ordre
  // choisi par l'utilisateur pour le reste est préservé).
  const visibleBlockOrder = isRestrictedCommercial
    ? blockOrder.filter((id) => !HIDDEN_BLOCKS_FOR_COMMERCIAL.includes(id))
    : blockOrder;

  const moveBlock = (id, dir) => {
    setBlockOrder((prev) => {
      const idx = prev.indexOf(id);
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };
  const dragBlockRef = useRef(null);
  const handleBlockDragStart = (id) => () => { dragBlockRef.current = id; };
  const handleBlockDragOver = (e) => { e.preventDefault(); };
  const handleBlockDrop = (targetId) => (e) => {
    e.preventDefault();
    const draggedId = dragBlockRef.current;
    dragBlockRef.current = null;
    if (!draggedId || draggedId === targetId) return;
    setBlockOrder((prev) => {
      const next = prev.filter((x) => x !== draggedId);
      const targetIdx = next.indexOf(targetId);
      next.splice(targetIdx, 0, draggedId);
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ preset: period.preset });
      if (period.preset === 'custom') {
        qs.set('start', period.start);
        qs.set('end', period.end);
      }
      const res = await fetch(`api/dashboard?${qs.toString()}`, {
        headers: credHeaders(password),
      });
      if (res.status === 401) { onLogout(); return; }
      if (!res.ok) throw new Error('Erreur serveur');
      setData(await res.json());
    } catch (e) {
      setError(String(e.message || e));
    } finally { setLoading(false); }
  }, [password, onLogout, period]);

  // Fetch newsletter stats (indépendant, non bloquant)
  const loadNl = useCallback(async () => {
    setNlLoading(true);
    try {
      const qs = new URLSearchParams({ preset: period.preset });
      if (period.preset === 'custom') { qs.set('start', period.start); qs.set('end', period.end); }
      const res = await fetch(`api/newsletter-stats?${qs.toString()}`, {
        headers: credHeaders(password),
      });
      if (res.ok) setNlData(await res.json());
    } catch { /* silencieux */ } finally { setNlLoading(false); }
  }, [password, period]);

  useEffect(() => { loadNl(); }, [loadNl]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh périodique (même principe que TvView) : silencieux tant que
  // `data` est déjà chargé — `loading && !data` (écran plein) ne se déclenche
  // pas, seul le bouton "Rafraîchir" clignote brièvement en "Maj…".
  useEffect(() => {
    const it = setInterval(load, DASHBOARD_REFRESH_MS);
    return () => clearInterval(it);
  }, [load]);

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
      const r = await fetch('api/admin/email-view', {
        method: 'POST',
        headers: credHeaders(password, { 'Content-Type': 'application/json' }),
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
    const onKey = (e) => { if (e.key === 'Escape') { setModal(null); setNlModal(null); setShowSettings(false); setShowEmail(false); } };
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

  // Pour un manager, le filtre "Sales" ne doit proposer que les membres de sa
  // propre équipe (celle-ci est de toute façon la seule qu'il voit) — jamais
  // tout le roster ni les autres équipes.
  const myTeamMembers = isRestrictedManager
    ? (teams.find((t) => t.id === password.teamId)?.members || [])
    : null;

  // ===== FILTRAGE ÉQUIPE / SALES + masqués (paramètres) =====
  // allowed = Set des noms autorisés, ou null = pas de filtre
  const allowed = allowedNames(teamFilter, saleFilter, teams);
  const hidden = new Set(hiddenSales);
  const isManager = (name) => managersDynamic.includes(name);
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
  const propals = fBlock(d.propals || { total: 0, totalAmount: 0, detail: [] }, true);
  const calls = fBlock(d.calls || { total: 0, detail: [] });
  const sf = fBlock(d.salesforge || { total: 0, detail: [] });
  const bdc = {
    sent: fBlock(d.bdc?.sent || { total: 0, detail: [] }),
    signed: fBlock(d.bdc?.signed || { total: 0, detail: [] }),
    pending: fBlock(d.bdc?.pending || { total: 0, detail: [] }),
  };
  // Propositions sur Comptes (statut Salesforce "Proposition envoyée")
  const propalsComptes = fBlock(d.propalsComptes || { total: 0, totalAmount: 0, detail: [] }, true);

  // Vue fusionnée Pistes + Comptes par commercial, pour le détail de la carte
  // "Propals" (qui affiche la somme des deux) — sans ça le clic sur la carte
  // n'ouvrait que le détail des pistes, les comptes restaient invisibles.
  const propalsMerged = (() => {
    const map = new Map();
    for (const r of propals.detail || []) {
      map.set(r.name, { name: r.name, leads: r.count || 0, comptes: 0, amount: r.amount || 0 });
    }
    for (const r of propalsComptes.detail || []) {
      const e = map.get(r.name) || { name: r.name, leads: 0, comptes: 0, amount: 0 };
      e.comptes = r.count || 0;
      e.amount = (e.amount || 0) + (r.amount || 0);
      map.set(r.name, e);
    }
    return Array.from(map.values())
      .map((e) => ({ ...e, count: e.leads + e.comptes }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  })();
  const propalsExtraCols = [
    { label: 'Pistes', render: (r) => r.leads },
    { label: 'Comptes', render: (r) => r.comptes },
    { label: 'Estimé', render: (r) => `${fmt(r.amount)} €` },
  ];

  // Repère "mois en cours" (sous CA & Signatures), masqué si la période EST déjà ce mois
  const isThisMonth = (d.range?.preset || 'today') === 'this_month';
  const monthRev = fBlock(d.monthRevenue || { totalAmount: 0, detail: [] }, true);
  const monthSig = fBlock(d.monthSignatures || { total: 0, totalAmount: 0, detail: [] }, true);

  // ===== Objectifs individuels : progression du CA du mois en cours par
  // commercial vs objectif réglé dans ⚙️ Paramètres (server/index.js /api/objectifs).
  // isThisMonth : rev.detail EST déjà le mois en cours, pas besoin de monthRev en double.
  const caMoisParRep = new Map((isThisMonth ? rev.detail : monthRev.detail || []).map((r) => [r.name, r.amount || 0]));
  const objectifsProgress = objectifs
    .filter((o) => o.monthlyObjective > 0 && filterRows([{ name: o.displayName }]).length > 0)
    .map((o) => {
      const ca = caMoisParRep.get(o.displayName) || 0;
      return { ...o, ca, pct: Math.min(100, Math.round((ca / o.monthlyObjective) * 100)) };
    })
    .sort((a, b) => b.pct - a.pct);

  // ===== Tunnel de conversion Calls → RDV pris → Propal → Signature =====
  // Aucune nouvelle donnée : les 4 totaux existent déjà (calls, rdvB.r1/r2,
  // propals + propalsComptes, sig) — juste des ratios entre étapes.
  const funnelRate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  const funnelStages = [
    { label: 'Calls', value: calls.total, color: '#3B82F6' },
    { label: 'RDV pris', value: rdvB.r1.total + rdvB.r2.total, color: '#FBBF24', text: '#713F12' },
    { label: 'Propals', value: propals.total + propalsComptes.total, color: '#F97316' },
    { label: 'Signatures', value: sig.total, color: '#8B5CF6' },
  ].map((s, i, arr) => ({ ...s, rate: i === 0 ? null : funnelRate(s.value, arr[i - 1].value) }));

  // ===== Leaderboard hebdo (Calls / RDV pris / CA), respecte le filtre équipe/masquage =====
  const weekCalls = fBlock(weekData?.calls || { total: 0, detail: [] });
  const weekRev = fBlock(weekData?.revenue || { totalAmount: 0, detail: [] }, true);
  const weekPropals = fBlock(weekData?.propals || { total: 0, totalAmount: 0, detail: [] }, true);
  const weekRdvMerged = (() => {
    const map = new Map();
    const addAll = (rows) => (rows || []).forEach((r) => map.set(r.name, (map.get(r.name) || 0) + (r.count || 0)));
    addAll(weekData?.rdvBooked?.r1?.detail);
    addAll(weekData?.rdvBooked?.r2?.detail);
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .filter((r) => filterRows([r]).length > 0)
      .sort((a, b) => b.count - a.count);
  })();

  // ===== Alerte de seuil : objectif de CA mensuel (0 = pas d'objectif défini) =====
  // Rythme attendu = objectif au prorata du nombre de jours déjà écoulés dans
  // le mois (ex : au 10e jour d'un mois de 30, on "devrait" être à 33%).
  // Seuils : ≥90% du rythme = ok, ≥70% = attention, en-dessous = alerte.
  const monthlyObjective = Number(d.settings?.monthlyRevenueObjective) || 0;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expectedByNow = monthlyObjective > 0 ? monthlyObjective * (now.getDate() / daysInMonth) : 0;
  const objectivePct = expectedByNow > 0 ? Math.round((monthRev.totalAmount / expectedByNow) * 100) : null;
  const objectiveStatus = objectivePct === null ? null : objectivePct >= 90 ? 'ok' : objectivePct >= 70 ? 'warn' : 'danger';

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
      ? (teams.find((t) => t.id === teamFilter)?.label || '')
      : null;
  const filterLabel = [baseLabel, roleLabel].filter(Boolean).join(' · ') || null;

  // Export CSV (ouvrable dans Excel/Sheets) de la vue courante : un fichier
  // "long format" (une ligne par KPI × commercial), pour ceux qui veulent
  // sortir un chiffre en réunion sans repasser par le reporting email.
  // Respecte les mêmes filtres/masquages que ce qui est affiché à l'écran.
  const exportCsv = () => {
    const sections = [
      ['Calls', calls, false],
      ['R1 tenus', rdvT.r1, false],
      ['R2 tenus', rdvT.r2, false],
      ['R1 pris', rdvB.r1, false],
      ['R2 pris', rdvB.r2, false],
      ['Propals pistes', propals, true],
      ['Propals comptes', propalsComptes, true],
      ['Signatures', sig, true],
      ['CA', rev, true],
      ['RDV SalesForge', sf, false],
      ['BDC envoyés', bdc.sent, false],
      ['BDC signés', bdc.signed, false],
      ['BDC en attente', bdc.pending, false],
    ];
    // Colonnes texte entre guillemets (échappés) ; colonnes numériques SANS
    // guillemets, sinon Excel les importe comme du texte au lieu de nombres
    // (impossible de sommer/grapher la colonne ensuite).
    const str = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [[str('KPI'), str('Commercial'), str('Compteur'), str('Montant (€)')].join(';')];
    for (const [label, block, withAmount] of sections) {
      for (const row of (block?.detail || [])) {
        if (!row.count && !row.amount) continue; // lignes à 0 omises pour ne pas polluer l'export
        const montant = withAmount ? Math.round(row.amount || 0) : '';
        lines.push([str(label), str(row.name), row.count || 0, montant].join(';'));
      }
    }
    // BOM UTF-8 : sans lui, Excel affiche mal les accents à l'ouverture directe du CSV.
    const csv = String.fromCharCode(0xfeff) + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = (filterLabel || 'global').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    a.href = url;
    a.download = `openmedias-dashboard_${d.range?.preset || 'periode'}_${slug}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Réglage de l'objectif de CA mensuel (admin) — même pattern léger que
  // "addMyself" (window.prompt) plutôt qu'une nouvelle modale pour un seul champ.
  const editMonthlyObjective = async () => {
    const input = window.prompt(
      "Objectif de CA mensuel (€), pour l'alerte de rythme sur la tuile CA. 0 pour désactiver l'alerte.",
      String(monthlyObjective || '')
    );
    if (input === null) return;
    const n = Math.max(0, parseInt(input.replace(/[^\d]/g, ''), 10) || 0);
    try {
      const r = await fetch('api/admin/settings', {
        method: 'POST',
        headers: credHeaders(password, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ monthlyRevenueObjective: n }),
      });
      if (!r.ok) throw new Error('Échec de la sauvegarde');
      load(); // recharge le dashboard pour refléter le nouvel objectif
    } catch (e) {
      window.alert(String(e.message || e));
    }
  };

  // ouvre une modale
  const openModal = (title, rows, isAmount, accent, cmpRows, extraCols) =>
    setModal({ title, rows: rows || [], isAmount: !!isAmount, accent: accent || 'c-blue', cmpRows: cmpRows || [], extraCols: extraCols || null });
  // Helper : récupère le detail filtré d'un bloc de comparaison
  const cmpDetail = (block) => fBlock(block || { total: 0, detail: [] }).detail;
  const cmpDetailAmt = (block) => fBlock(block || { totalAmount: 0, detail: [] }, true).detail;

  // graphes : seulement sales > 0
  const caBySales = (rev.detail || []).filter((r) => r.amount > 0).slice(0, 8).map((r) => ({
    name: r.name.split(' ')[0], value: r.amount,
  }));
  // CA 12 mois glissants : 'YYYY-MM' -> "juil. 25"
  const revenueByMonthChart = (monthlyRevenue || []).map((m) => {
    const [y, mo] = m.month.split('-').map(Number);
    const label = new Date(y, mo - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    return { name: label, value: m.totalAmount || 0 };
  });
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

  // ---- Contenu de chaque bloc réorganisable (cf. DEFAULT_BLOCK_ORDER) ----
  // Chaque valeur est le contenu (tuiles) d'un bloc ; le wrapper `.grid` autour
  // de chaque bloc est ajouté au rendu, pas ici, pour garder la grille 12
  // colonnes fonctionnelle à l'intérieur de chaque bloc indépendamment de
  // l'ordre choisi par l'utilisateur.
  const BLOCKS = {
    hero: (
      <>
        <Kpi label="Calls" value={calls.truncated ? `${fmt(calls.total)}+` : calls.total}
          sub={calls.truncated ? 'plafonné' : 'passés'} color="c-blue" dot="#3B82F6"
          secondary={[
            { value: callsOut, label: 'out', dot: '#2563EB' },
            { value: callsIn, label: 'in', dot: '#60A5FA' },
          ]}
          delta={dCalls}
          clickable onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue', cmp ? cmpDetail(cmp.calls) : [])} />
        <Kpi label="R1" value={rdvT.r1.total} sub="échanges" color="c-green" dot="#22C55E"
          secondary={{ value: rdvB.r1.total, label: 'pris', dot: '#FBBF24' }}
          delta={dR1}
          clickable onClick={() => openModal('R1 par commercial', rdvT.r1.detail, false, 'c-green', cmp ? cmpDetail(cmp.rdvToday?.r1) : [])} />
        <Kpi label="R2" value={rdvT.r2.total} sub="retours" color="c-bluer2" dot="#22D3EE"
          secondary={{ value: rdvB.r2.total, label: 'pris', dot: '#FBBF24' }}
          delta={dR2}
          clickable onClick={() => openModal('R2 par commercial', rdvT.r2.detail, false, 'c-bluer2', cmp ? cmpDetail(cmp.rdvToday?.r2) : [])} />
        <Kpi label="Propals" value={propals.total + propalsComptes.total} sub="envoyées" color="c-orange" dot="#F97316"
          secondary={[
            { value: propals.total, label: 'pistes', dot: '#F97316' },
            { value: propalsComptes.total, label: 'comptes', dot: '#FBBF24' },
            { value: `${fmt(propals.totalAmount)} €`, label: 'estimé pistes', dot: '#FDBA74' },
          ]}
          delta={dPropals}
          clickable onClick={() => openModal('Propals (pistes + comptes) par commercial', propalsMerged, false, 'c-orange', [], propalsExtraCols)} />
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
          {objectiveStatus && (
            <div
              className={`objective-badge ${objectiveStatus}`}
              onClick={isAdmin ? editMonthlyObjective : undefined}
              style={isAdmin ? { cursor: 'pointer' } : undefined}
              title={
                isAdmin
                  ? `Objectif du mois : ${fmt(monthlyObjective)}€ — clique pour modifier`
                  : `Objectif du mois : ${fmt(monthlyObjective)}€`
              }
            >
              🎯 {objectivePct}% du rythme visé
            </div>
          )}
          {!objectiveStatus && isAdmin && (
            <div
              className="objective-badge muted"
              onClick={editMonthlyObjective}
              style={{ cursor: 'pointer' }}
              title="Définir un objectif de CA mensuel"
            >
              🎯 Définir un objectif
            </div>
          )}
        </div>
      </>
    ),

    money: (
      <>
        <div className="tile col-8 clickable" onClick={() => openModal(`CA · ${rangeLabel} par commercial`, rev.detail, true, 'c-blue', cmp ? cmpDetailAmt(cmp.revenue) : [])}>
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
      </>
    ),

    ca12mois: (
      <div className="tile col-12">
        <TileHead dotClass="bg-blue" title="CA — 12 derniers mois" />
        <div className="chart-box" style={{ height: 220 }}>
          {revenueByMonthChart.every((m) => m.value === 0) ? (
            <div className="empty">Aucune donnée</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueByMonthChart} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                <XAxis dataKey="name" tick={{ fill: ct.tick, fontSize: 11 }} axisLine={{ stroke: ct.axis }} tickLine={false} />
                <YAxis tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} width={50}
                  tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip content={<DarkTooltip suffix=" €" />} cursor={{ fill: 'rgba(59,130,246,0.10)' }} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                  {revenueByMonthChart.map((e, i) => (
                    <Cell key={i} fill={i === revenueByMonthChart.length - 1 ? '#3B82F6' : '#2563EB'} fillOpacity={i === revenueByMonthChart.length - 1 ? 1 : 0.55} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    ),

    activite: (
      <>
        <div className="tile col-5 clickable" onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue', cmp ? cmpDetail(cmp.calls) : [])}>
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
                  onClick={() => openModal(meta.title, bdc[bdcView].detail, false, meta.color, cmp && cmp.bdc ? cmpDetail(cmp.bdc[bdcView]) : [])}
                >
                  ⤢ Voir tout
                </div>
              </>
            );
          })()}
        </div>
      </>
    ),

    classements: (
      <>
        <div className="tile col-3">
          <TileHead dotClass="bg-orange" title="Propals" />
          <div
            className="subsec clickable-zone"
            onClick={() => openModal('Propals Pistes par commercial', propals.detail, false, 'c-orange', cmp ? cmpDetail(cmp.propals) : [], [{ label: 'Estimé', render: (r) => `${fmt(r.amount || 0)} €` }])}
          >
            <div className="subsec-head">
              <span>Pistes</span>
              <b className="c-orange">{propals.total}</b>
            </div>
            <div className="kpi-sub" style={{ marginTop: -4, marginBottom: 6 }}>
              {fmt(propals.totalAmount)} € estimés
            </div>
            <TopList rows={propals.detail} color="c-orange" max={4} />
          </div>
          <div
            className="subsec clickable-zone"
            onClick={() => openModal('Propositions Comptes par commercial', propalsComptes.detail, false, 'c-amber', cmp ? cmpDetail(cmp.propalsComptes) : [], [{ label: 'Estimé', render: (r) => `${fmt(r.amount || 0)} €` }])}
          >
            <div className="subsec-head">
              <span>Comptes</span>
              <b className="c-amber">{propalsComptes.total}</b>
            </div>
            <div className="kpi-sub" style={{ marginTop: -4, marginBottom: 6 }}>
              {fmt(propalsComptes.totalAmount)} € estimés
            </div>
            <TopList rows={propalsComptes.detail} color="c-amber" max={5} />
          </div>
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('R1 pris par commercial', rdvB.r1.detail, false, 'c-amber', cmp ? cmpDetail(cmp.rdvBooked?.r1) : [])}>
          <TileHead dotClass="bg-amber" title="R1 pris par sales" clickable />
          <TopList rows={rdvB.r1.detail} color="c-amber" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('R2 pris par commercial', rdvB.r2.detail, false, 'c-amber', cmp ? cmpDetail(cmp.rdvBooked?.r2) : [])}>
          <TileHead dotClass="bg-amber" title="R2 pris par sales" clickable />
          <TopList rows={rdvB.r2.detail} color="c-amber" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('RDV SalesForge par commercial', sf.detail, false, 'c-bluer2', cmp ? cmpDetail(cmp.salesforge) : [])}>
          <TileHead dotClass="bg-bluer2" title={`SalesForge · ${sf.total} RDV`} clickable />
          <TopList rows={sf.detail} color="c-bluer2" />
        </div>
      </>
    ),

    // N'affiche rien (bloc masqué en mode normal) tant qu'aucun objectif n'est réglé.
    objectifs: objectifsProgress.length > 0 ? (
      <div className="tile col-6">
        <TileHead dotClass="bg-green" title="Objectifs du mois en cours" />
        <div className="obj-list">
          {objectifsProgress.map((o) => (
            <div className="obj-row" key={o.commercialId}>
              <div className="obj-row-top">
                <span className="obj-name">{o.displayName}</span>
                <span className="obj-val">{fmt(o.ca)} € / {fmt(o.monthlyObjective)} €</span>
              </div>
              <div className="mrow-bar-bg">
                <div
                  className={`mrow-bar ${o.pct >= 100 ? 'c-green-bg' : o.pct >= 70 ? 'c-amber-bg' : 'c-blue-bg'}`}
                  style={{ width: `${o.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    ) : null,

    newsletter: (
      <NewsletterSection
        nlData={nlData}
        nlLoading={nlLoading}
        rangeLabel={rangeLabel}
        onOpenCampaigns={() => setNlModal('campaigns')}
      />
    ),

    // Regroupe tunnel de conversion + podium hebdo — regardé en second, après
    // les chiffres du jour/de la période (demande explicite : moins prioritaire
    // au premier coup d'œil que les tuiles chiffrées du dessus).
    // Vue commercial : seul le tunnel reste, le podium est masqué comme le
    // reste des blocs sous "CA - 12 mois glissants".
    synthese: (
      <>
        <div className="tile col-12">
          <TileHead dotClass="bg-violet" title={`Tunnel de conversion · ${rangeLabel}`} />
          <ConversionFunnel stages={funnelStages} />
        </div>
        {!isRestrictedCommercial && (
          <div className="tile col-12">
            <div className="tile-head">
              <span className="tile-dot bg-amber" />
              <span className="tile-title">Podium de la semaine</span>
              <label className="lb-anon-toggle" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={lbAnonymized} onChange={(e) => setLbAnonymized(e.target.checked)} />
                Anonymiser
              </label>
            </div>
            <Leaderboard
              callsDetail={weekCalls.detail}
              rdvDetail={weekRdvMerged}
              revenueDetail={weekRev.detail}
              anonymized={lbAnonymized}
            />
          </div>
        )}
      </>
    ),
  };

  return (
    <div className="shell">
      {/* TOPBAR — barre d'identité sticky (app-switch + marque), même
          traitement que le header du planning. Les filtres/actions vivent
          maintenant dans .dash-toolbar juste en dessous (2e bande, non
          sticky) : même découpage à deux bandes que le planning
          (header sticky + .toolbar), au lieu de tout entasser sur une seule
          ligne dense — c'était la plus grosse source de "ça ne se ressemble
          pas d'un onglet à l'autre" malgré des tokens déjà alignés. */}
      <div className="topbar">
        <div className="topbar-left">
          {/* NAVIGATION PRINCIPALE — Dashboard / Planning : les deux piliers
              d'OpenMedias, intégrés directement dans la topbar (plutôt qu'une
              bande séparée au-dessus, qui créait une double bordure disgracieuse). */}
          <div className="app-switch">
            <button className="app-switch-btn active">📊 Dashboard</button>
            <button className="app-switch-btn" onClick={() => { window.location.href = '/planning'; }}>📅 Planning</button>
            {/* Radar éditorial (radar/frontend, servi sous /radar) : quelles
                émissions couvrent le thème d'un prospect, chez nous vs chez les
                concurrents. Ouvert à tous les rôles, donc pas de condition. */}
            <button className="app-switch-btn" onClick={() => { window.location.href = '/radar'; }}>📡 Radar</button>
            {/* Réglages (comptes/rôles/équipes/reporting) : un seul endroit, dans
                le planning, réservé aux comptes admin. */}
            {isAdmin && (
              <button className="app-switch-btn" onClick={() => { window.location.href = '/planning?view=parametres'; }}>⚙️ Paramètres</button>
            )}
          </div>
          <div className="brand-block">
            <div className="brand-mark" />
            <div className="brand-text">
              <div className="brand-eyebrow">OpenMedias</div>
              <div className="brand-title">OpenDashboard</div>
            </div>
          </div>
          {/* La date/le filtre actif vivaient ici en double : le sélecteur de
              période (PeriodSelector, dans la barre du dessous) affiche déjà
              "Aujourd'hui"/la plage choisie, et les FilterDropdown Rôle/
              Équipes/Sales affichent déjà le filtre actif dans leur propre
              libellé — .context-line ne faisait que répéter la même info,
              ce qui expliquait pourquoi rien ne s'arrangeait bien ici : il
              n'y avait tout simplement rien d'utile à étaler dans cette
              barre. Retiré entièrement ; seul le compteur "masqués" (la
              seule info qui n'existe nulle part ailleurs) part avec les
              filtres dans la barre du dessous. */}
        </div>
      </div>

      {/* TOOLBAR — filtres + actions, même bande que .toolbar côté planning
          (fond + bordure basse, padding 10px/24px, PAS sticky : elle défile
          avec le contenu, seule l'identité au-dessus reste fixe). Le bouton
          burger vit ici (pas dans .topbar) : c'est cette bande qu'il
          cache/montre sur mobile, ça n'a de sens que côte à côte. */}
      <div className="dash-toolbar">
        <button
          className="burger-btn"
          onClick={() => setMobileMenuOpen((o) => !o)}
          aria-label={mobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? '✕' : '☰'}
        </button>
        <div className={`topbar-controls-panel${mobileMenuOpen ? ' open' : ''}`}>
          <div className="controls-group">
            {showCrossTeamFilters && (
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
            )}
            {showCrossTeamFilters && (
              <FilterDropdown
                icon="👥"
                label={teamFilter ? (teams.find((t) => t.id === teamFilter)?.label || 'Équipe') : 'Équipes'}
                allLabel="Toutes les équipes"
                items={teams.map((t) => ({ value: t.id, label: t.label }))}
                current={teamFilter}
                onPick={(v) => { setTeamFilter(v); setSaleFilter(null); }}
              />
            )}
            {/* Un commercial ne voit déjà que ses propres chiffres (scopés côté
                serveur) — un filtre "Sales" n'aurait ici aucun sens. */}
            {!isRestrictedCommercial && (
              <FilterDropdown
                icon="👤"
                label={saleFilter || 'Sales'}
                allLabel="Tous les sales"
                items={(isRestrictedManager
                  ? myTeamMembers
                  : teamFilter
                    ? (teams.find((t) => t.id === teamFilter)?.members || [])
                    : allSales
                ).filter((s) => !hidden.has(s) && roleOk(s)).map((s) => ({ value: s, label: s }))}
                current={saleFilter}
                onPick={(v) => setSaleFilter(v)}
              />
            )}
            <PeriodSelector
              current={d.range?.preset || 'today'}
              label={rangeLabel}
              onApply={(p) => setPeriod(p)}
            />
            {/* Seule info de .context-line qui n'existait nulle part ailleurs
                (contrairement à la date et au filtre actif, déjà visibles
                via PeriodSelector et les FilterDropdown ci-dessus) — sa place
                est ici, à côté des filtres qui déterminent justement qui est
                affiché ou masqué. */}
            {hidden.size > 0 && <span className="hidden-chip">{hidden.size} masqué{hidden.size > 1 ? 's' : ''}</span>}
          </div>
          <div className="topbar-divider" />
          <div className="status-cluster">
            <button className="theme-btn" onClick={() => setShowTv(true)} title="Mode TV — projection openspace">
              📺
            </button>
            <button
              className={`theme-btn ${editMode ? 'active' : ''}`}
              onClick={() => setEditMode((v) => !v)}
              title={editMode ? 'Terminer la réorganisation' : 'Réorganiser les blocs du dashboard (glisser-déposer)'}
            >
              {editMode ? '✅' : '✏️'}
            </button>
            {isRestrictedCommercial && (
              <button className="theme-btn" onClick={() => setShowMaSemaine(true)} title="Ma semaine">
                📅
              </button>
            )}
            <button className="theme-btn" onClick={exportCsv} title="Exporter cette vue en CSV (Excel/Sheets)">
              📥
            </button>
            {isAdmin && (
              <button className="theme-btn" onClick={() => setShowSettings(true)} title="Paramètres">
                ⚙️
              </button>
            )}
            {isAdmin && (
              /* ✉️ ne s'affichait pas sur certaines combinaisons OS/police (ex:
                 Chrome/Windows) et rendait une case vide (confirmé en prod le
                 22/07), d'où le passage en SVG à l'époque — mais ça détonnait
                 visuellement à côté des emojis ⚙️/🌙 voisins. 📧 reprend le
                 style emoji sans reproduire le bug de rendu de ✉️ (à surveiller
                 quand même : si un souci de rendu réapparaît sur un
                 OS/navigateur donné, revenir au SVG ci-dessus en commentaire). */
              <button className="theme-btn" onClick={() => setShowEmail(true)} title="Envoyer cette vue par mail">
                📧
              </button>
            )}
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

      <div className="dash-blocks">
        {visibleBlockOrder.map((blockId, idx) => {
          const content = BLOCKS[blockId];
          if (!content && !editMode) return null;
          return (
            <div
              key={blockId}
              className={`dash-block ${editMode ? 'edit-mode' : ''}`}
              draggable={editMode}
              onDragStart={editMode ? handleBlockDragStart(blockId) : undefined}
              onDragOver={editMode ? handleBlockDragOver : undefined}
              onDrop={editMode ? handleBlockDrop(blockId) : undefined}
            >
              {editMode && (
                <div className="dash-block-bar">
                  <span className="dash-block-handle">⠿</span>
                  <span className="dash-block-name">{BLOCK_LABELS[blockId]}</span>
                  <button className="dash-block-btn" onClick={() => moveBlock(blockId, -1)} disabled={idx === 0} title="Monter">▲</button>
                  <button className="dash-block-btn" onClick={() => moveBlock(blockId, 1)} disabled={idx === visibleBlockOrder.length - 1} title="Descendre">▼</button>
                </div>
              )}
              <div className="grid">{content}</div>
            </div>
          );
        })}
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

      {nlModal === 'campaigns' && (
        <NlCampaignsModal
          campaigns={(nlData?.newsletters?.campaigns) || []}
          onClose={() => setNlModal(null)}
        />
      )}

      {showTv && (
        <TvView
          password={password}
          hiddenSales={hiddenSales}
          onClose={() => setShowTv(false)}
          teams={teams}
        />
      )}

      <MaSemaineModal
        open={showMaSemaine}
        onClose={() => setShowMaSemaine(false)}
        nom={password?.nom}
        callsTotal={weekCalls.total}
        propalsTotal={weekPropals.total}
        propalsAmount={weekPropals.totalAmount}
        upcoming={mesRdv}
      />

      <SettingsModal
        open={showSettings}
        hidden={hidden}
        onToggle={toggleHidden}
        onShowAll={() => setHiddenSales([])}
        onClose={() => setShowSettings(false)}
        password={password}
        teams={teams}
        onTeamsChanged={loadTeams}
        objectifs={objectifs}
        onObjectifsChanged={loadObjectifs}
        allSales={allSales}
      />

      <DetailModal
        open={!!modal}
        title={modal?.title}
        rows={modal?.rows || []}
        isAmount={modal?.isAmount}
        accent={modal?.accent}
        cmpRows={modal?.cmpRows || []}
        extraCols={modal?.extraCols || null}
        onClose={() => setModal(null)}
      />
    </div>
  );
}

// ---------- ROOT ----------
export default function App() {
  const [password, setPassword] = useState(null); // `password` = objet credential (voir credHeaders/isAdminCred plus haut)
  // Tant que la vérification de session (sessionStorage / auto-login via
  // commercialId) n'est pas terminée, on n'affiche ni l'écran de connexion ni
  // le dashboard : avant ce correctif, `password` valait `null` pendant tout
  // l'aller-retour réseau de /api/auth/me, donc <Login/> s'affichait puis
  // disparaissait aussitôt — un clignotement bien visible à chaque passage de
  // /planning vers "/". `checkingSession` évite ce flash (rendu vide le temps
  // de la vérification, quasi instantané dans le cas courant).
  const [checkingSession, setCheckingSession] = useState(true);
  // Clé localStorage partagée avec planning/frontend/index.html ('theme',
  // pas 'om_theme') — avant, chaque app avait sa propre clé ET son propre
  // défaut (dashboard sombre, planning clair), donc changer le thème d'un
  // côté n'affectait jamais l'autre et la première impression différait
  // selon le point d'entrée (relevé dans l'audit UX). Même clé + même défaut
  // (clair) des deux côtés maintenant ; localStorage est bien partagé entre
  // "/" et "/planning" (même origine).
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  useEffect(() => {
    const saved = sessionStorage.getItem('om_cred');
    if (saved) {
      try {
        const cred = JSON.parse(saved);
        // Un compte édito/communication qui revient sur la racine du domaine
        // (ex: lien direct, retour navigateur) est renvoyé vers le planning —
        // il n'a jamais eu accès au dashboard, même via une session déjà ouverte.
        if (cred.mode === 'commercial' && ['edito', 'communication'].includes(cred.role)) {
          window.location.href = '/planning';
          return;
        }
        setPassword(cred);
        setCheckingSession(false);
        return;
      } catch { /* session pré-fusion invalide, ignorée */ }
    }
    // Pas de session dans cet onglet (sessionStorage est propre à chaque onglet) :
    // si un commercialId existe déjà en localStorage (ouvert depuis le planning,
    // ou un autre onglet du dashboard), on retente une connexion silencieuse via
    // /api/auth/me au lieu d'afficher l'écran de connexion — c'est tout l'intérêt
    // du portail unique (pas de re-login en changeant d'onglet/de page).
    const storedId = localStorage.getItem('commercialId');
    if (storedId) {
      fetch('api/auth/me', { headers: { 'x-commercial-id': storedId } })
        .then((r) => { if (!r.ok) throw new Error('session invalide'); return r.json(); })
        .then((d) => {
          const cred = {
            mode: 'commercial', commercialId: d.commercial_id, nom: d.nom,
            isAdmin: !!d.isAdmin, role: d.accountRole, teamId: d.teamId,
          };
          if (['edito', 'communication'].includes(cred.role)) {
            window.location.href = '/planning';
            return;
          }
          sessionStorage.setItem('om_cred', JSON.stringify(cred));
          setPassword(cred);
        })
        .catch(() => {
          // Compte supprimé/désactivé depuis : on nettoie pour retomber sur l'écran de connexion.
          localStorage.removeItem('commercialId'); localStorage.removeItem('commercialNom');
        })
        .finally(() => setCheckingSession(false));
    } else {
      setCheckingSession(false);
    }
  }, []);

  // Applique le thème sur <html> et mémorise la préférence
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const handleSuccess = useCallback((cred) => {
    sessionStorage.setItem('om_cred', JSON.stringify(cred));
    // SSO vers OpenPlanning (/planning) : même compte commercial, mêmes clés
    // localStorage que le planning attend (commercialId/commercialNom) — évite
    // de se reconnecter en passant d'un onglet à l'autre.
    if (cred.mode === 'commercial') {
      localStorage.setItem('commercialId', String(cred.commercialId));
      localStorage.setItem('commercialNom', cred.nom || '');
    }
    // Édito et communication n'ont pas accès au dashboard — leur landing page
    // est directement le planning (redirection immédiate après connexion).
    if (cred.mode === 'commercial' && ['edito', 'communication'].includes(cred.role)) {
      window.location.href = '/planning';
      return;
    }
    setPassword(cred);
  }, []);
  const handleLogout = useCallback(() => {
    sessionStorage.removeItem('om_cred');
    localStorage.removeItem('commercialId');
    localStorage.removeItem('commercialNom');
    setPassword(null);
  }, []);

  if (checkingSession) return null;
  if (!password) return <Login onSuccess={handleSuccess} />;
  return <Dashboard password={password} onLogout={handleLogout} theme={theme} onToggleTheme={toggleTheme} />;
}

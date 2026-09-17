import React, { useState } from 'react';
export default function Login({ onSuccess }) {
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

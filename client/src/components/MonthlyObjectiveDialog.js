import React, { useEffect, useRef, useState } from 'react';
import './MonthlyObjectiveDialog.css';

export default function MonthlyObjectiveDialog({ value, save, close }) {
  const [amount, setAmount] = useState(String(value || 0));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  const input = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    input.current.focus();
    input.current.select();
    return () => previous?.focus();
  }, []);
  async function submit(event) {
    event.preventDefault();
    const number = Number(amount);
    if (!amount.trim() || !Number.isSafeInteger(number) || number < 0) {
      setError('Saisis un montant entier en euros, supérieur ou égal à 0.');
      return;
    }
    setPending(true); setError('');
    try { await save(number); close(); }
    catch (e) { setError(e.message || 'Enregistrement impossible. Réessaie.'); setPending(false); }
  }
  return (
    <dialog ref={dialog} className="objective-dialog" aria-labelledby="objective-title" aria-describedby="objective-description" onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
      <form onSubmit={submit}>
        <h2 id="objective-title">Objectif mensuel global</h2>
        <p id="objective-description">Montant de CA gagné visé chaque mois pour l’ensemble des commerciaux. Les objectifs individuels se règlent dans Paramètres.</p>
        <label htmlFor="objective-amount">Montant mensuel en euros</label>
        <input ref={input} id="objective-amount" type="number" inputMode="numeric" min="0" step="1" required value={amount} onChange={event => setAmount(event.target.value)} disabled={pending} aria-describedby="objective-help" />
        <p id="objective-help">0 désactive cet objectif. La nouvelle valeur s’affiche dès l’enregistrement.</p>
        {error && <p className="objective-error" role="alert">{error}</p>}
        <div className="objective-dialog-actions">
          <button type="button" onClick={close} disabled={pending}>Annuler</button>
          <button type="submit" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer l’objectif'}</button>
        </div>
      </form>
    </dialog>
  );
}

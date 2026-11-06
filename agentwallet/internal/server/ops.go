package server

import (
	"context"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

// op is something the user's wallet must sign: an owner auth entry
// (kind "auth"), a transaction (kind "tx") or a sign-in challenge.
type op struct {
	id      string
	owner   string
	kind    string // auth | tx | challenge
	summary string
	xdr     string // tx / challenge envelope
	hash    []byte
	expires time.Time

	oc *wallet.OwnerCall
	ut *wallet.UserTx

	// onSuccess runs after the transaction succeeds; its value is the
	// submit response's "result".
	onSuccess func(ctx context.Context, tx *wallet.Tx) (any, error)
	onFail    func() // the op failed or expired without a successful tx
	onExpire  func()
}

func (o *op) public(s *Server) map[string]any {
	out := map[string]any{
		"op_id": o.id, "kind": o.kind, "summary": o.summary, "hash": hexOf(o.hash),
		"network_passphrase": s.cfg.Wallet.Passphrase, "expires_at": o.expires.UTC().Format(time.RFC3339),
	}
	if o.kind == "challenge" {
		out["kind"] = "tx"
	}
	if o.oc != nil {
		out["preimage"] = o.oc.Preimage
	}
	if o.xdr != "" {
		out["xdr"] = o.xdr
	}
	return out
}

func (s *Server) addOp(o *op) *op {
	o.id = newID()
	if o.expires.IsZero() {
		o.expires = time.Now().Add(opTTL)
	}
	if o.onExpire == nil {
		o.onExpire = o.onFail
	}
	s.opsMu.Lock()
	s.ops[o.id] = o
	s.opsMu.Unlock()
	return o
}

// takeOp removes and returns an unexpired op of the given kind that belongs
// to owner (any owner when owner is ""). Ops are single use.
func (s *Server) takeOp(id, owner, kind string) *op {
	s.opsMu.Lock()
	defer s.opsMu.Unlock()
	o := s.ops[id]
	if o == nil || time.Now().After(o.expires) || (owner != "" && o.owner != owner) || (kind != "" && o.kind != kind) {
		return nil
	}
	delete(s.ops, id)
	return o
}

func (s *Server) authOp(owner, summary string, oc *wallet.OwnerCall, onSuccess func(context.Context, *wallet.Tx) (any, error), onFail func()) map[string]any {
	o := s.addOp(&op{owner: owner, kind: "auth", summary: summary, oc: oc, hash: oc.Hash, onSuccess: onSuccess, onFail: onFail})
	return o.public(s)
}

func (s *Server) txOp(owner, summary string, ut *wallet.UserTx, onSuccess func(context.Context, *wallet.Tx) (any, error)) map[string]any {
	o := s.addOp(&op{owner: owner, kind: "tx", summary: summary, ut: ut, xdr: ut.XDR, hash: ut.Hash, onSuccess: onSuccess})
	return o.public(s)
}

func (s *Server) handleSubmitOp(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SignedAuthEntry string `json:"signed_auth_entry"`
		SignedXDR       string `json:"signed_xdr"`
		Signature       string `json:"signature"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	o := s.takeOp(r.PathValue("id"), user(r), "")
	if o == nil || o.kind == "challenge" {
		writeErr(w, http.StatusNotFound, "not_found", "unknown or expired operation; prepare it again")
		return
	}
	sigB64 := req.SignedAuthEntry
	if sigB64 == "" {
		sigB64 = req.Signature
	}
	var sig []byte
	if sigB64 != "" {
		var err error
		if sig, err = base64.StdEncoding.DecodeString(sigB64); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_argument", "signature must be base64")
			return
		}
	}

	var tx *wallet.Tx
	var e *wallet.Error
	switch o.kind {
	case "auth":
		if sig == nil {
			writeErr(w, http.StatusBadRequest, "invalid_argument", "send signed_auth_entry or signature")
			return
		}
		tx, e = s.base.SubmitOwnerCall(r.Context(), o.oc, sig)
	case "tx":
		if req.SignedXDR == "" && sig == nil {
			writeErr(w, http.StatusBadRequest, "invalid_argument", "send signed_xdr or signature")
			return
		}
		tx, e = s.base.SubmitUserTx(r.Context(), o.ut, req.SignedXDR, sig)
	}
	if e != nil {
		if o.onFail != nil {
			o.onFail()
		}
		writeJSON(w, 200, map[string]any{"ok": false, "tx": txJSON(tx), "error": e})
		return
	}
	var result any
	if o.onSuccess != nil {
		res, err := o.onSuccess(r.Context(), tx)
		if err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "tx": txJSON(tx), "error": wallet.AsError(err)})
			return
		}
		result = res
	}
	writeJSON(w, 200, map[string]any{"ok": true, "tx": txJSON(tx), "result": result})
}

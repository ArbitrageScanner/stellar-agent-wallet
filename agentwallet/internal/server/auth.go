package server

import (
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"time"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// SEP-10 sign-in: the server signs a challenge tx (manage_data with a random
// nonce, bound to our home/web-auth domain, valid 5 minutes); the wallet
// co-signs it; the server verifies both signatures and opens a session.
// Challenges are single use.

func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Address string `json:"address"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	if !strkey.IsValidEd25519PublicKey(req.Address) {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "address must be a G… account")
		return
	}
	if !s.limiter.allow("challenge:"+clientIP(r), 30, time.Minute) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many sign-in attempts")
		return
	}
	tx, err := txnbuild.BuildChallengeTx(s.cfg.WebAuth.Seed(), req.Address, s.cfg.HomeDomain, s.cfg.HomeDomain,
		s.cfg.Wallet.Passphrase, 5*time.Minute, nil)
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	b64, _ := tx.Base64()
	h, _ := tx.Hash(s.cfg.Wallet.Passphrase)
	s.sendOp(w, &op{owner: req.Address, kind: "challenge", summary: "Sign in to agentwallet", xdr: b64, hash: h[:], expires: time.Now().Add(5 * time.Minute)})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OpID      string `json:"op_id"`
		SignedXDR string `json:"signed_xdr"`
		Signature string `json:"signature"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	o := s.takeOp(req.OpID, "", "challenge")
	if o == nil {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "unknown or expired challenge")
		return
	}
	signed := req.SignedXDR
	if signed == "" {
		sig, err := base64.StdEncoding.DecodeString(req.Signature)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_argument", "signature must be base64")
			return
		}
		gtx, err := txnbuild.TransactionFromXDR(o.xdr)
		if err != nil {
			writeErr(w, 500, "internal", err.Error())
			return
		}
		tx, _ := gtx.Transaction()
		kp, _ := keypair.ParseAddress(o.owner)
		tx, err = tx.AddSignatureDecorated(xdr.DecoratedSignature{Hint: xdr.SignatureHint(kp.Hint()), Signature: sig})
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_argument", err.Error())
			return
		}
		signed, _ = tx.Base64()
	}
	found, err := txnbuild.VerifyChallengeTxSigners(signed, s.cfg.WebAuth.Address(), s.cfg.Wallet.Passphrase,
		s.cfg.HomeDomain, []string{s.cfg.HomeDomain}, o.owner)
	if err != nil || len(found) == 0 || found[0] != o.owner {
		msg := "challenge signature is not valid"
		if err != nil {
			msg += ": " + err.Error()
		}
		writeErr(w, http.StatusUnauthorized, "signature_invalid", msg)
		return
	}
	// keep a recorded account if it is deployed; otherwise (new user, or an
	// account never deployed) record the address derived now
	account := s.accountOf(o.owner)
	if ok, err := s.base.AccountExists(r.Context(), account); err != nil || !ok {
		if account, err = s.base.AccountAddress(o.owner); err != nil {
			writeErr(w, 500, "internal", err.Error())
			return
		}
	}
	if err := s.db.UpsertUser(o.owner, account); err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	token, err := s.db.CreateSession(o.owner, sessionTTL)
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, 200, map[string]any{"address": o.owner, "account": account})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = s.db.DeleteSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteStrictMode})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	addr := user(r)
	account := s.accountOf(addr)
	// Both reads go to Stellar RPC, which can take seconds per call: run them concurrently.
	type exists struct {
		ok  bool
		err error
	}
	ch := make(chan exists, 1)
	go func() {
		ok, err := s.base.AccountExists(r.Context(), account)
		ch <- exists{ok, err}
	}()
	bal, balErr := s.base.GBalances(r.Context(), addr)
	ex := <-ch
	deployed, err := ex.ok, ex.err
	if err != nil {
		writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
		return
	}
	if err := balErr; err != nil {
		writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"address": addr, "account": account, "account_deployed": deployed, "wallet": bal,
		"account_url": s.cfg.Wallet.Explorer + "/contract/" + account,
		"address_url": s.cfg.Wallet.Explorer + "/account/" + addr,
		"chat":        map[string]any{"used": s.db.Used("chat:wallet:" + addr), "limit": s.cfg.Limits.ChatDailyWallet, "resets_at": nextUTCDay()},
	})
}

func hexOf(b []byte) string { return hex.EncodeToString(b) }

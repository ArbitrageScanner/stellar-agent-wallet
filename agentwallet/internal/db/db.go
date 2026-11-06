// Package db is the service's SQLite store: users, agents (keys sealed by
// the vault), API keys and sessions (stored as SHA-256 hashes only) and the
// payment log.
package db

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

const schema = `
CREATE TABLE IF NOT EXISTS users (
  address    TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users(address),
  name        TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  secret_enc  BLOB NOT NULL,
  rule_id     INTEGER,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner);
CREATE TABLE IF NOT EXISTS api_keys (
  hash         TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_agent ON api_keys(agent_id);
CREATE TABLE IF NOT EXISTS sessions (
  hash       TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  hash            TEXT NOT NULL,
  url             TEXT NOT NULL DEFAULT '',
  agent_id        TEXT NOT NULL,
  owner           TEXT NOT NULL,
  to_addr         TEXT NOT NULL,
  amount          TEXT NOT NULL,
  asset           TEXT NOT NULL,
  memo            TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  ledger          INTEGER,
  created_at      TEXT NOT NULL,
  idempotency_key TEXT,
  source          TEXT
);
CREATE INDEX IF NOT EXISTS payments_owner ON payments(owner, created_at);
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (day, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_idem ON payments(agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key != '';
`

type DB struct{ sql *sql.DB }

func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	s, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	if _, err := s.Exec(schema); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	_ = os.Chmod(path, 0o600)
	return &DB{sql: s}, nil
}

func (d *DB) Close() error { return d.sql.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// Hash is how tokens (sessions, API keys) are stored.
func Hash(token string) string { s := sha256.Sum256([]byte(token)); return hex.EncodeToString(s[:]) }

// Token returns prefix + 32 random bytes (base64url).
func Token(prefix string) string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

func NewID(prefix string) string {
	b := make([]byte, 9)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

var ErrNotFound = errors.New("not found")

// ---------------------------------------------------------------- users

func (d *DB) UpsertUser(address, account string) error {
	_, err := d.sql.Exec(`INSERT INTO users(address, account, created_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET account=excluded.account`, address, account, now())
	return err
}

// UserAccount is the smart account recorded for a user ("" if unknown).
func (d *DB) UserAccount(address string) (string, error) {
	var a string
	err := d.sql.QueryRow(`SELECT account FROM users WHERE address=?`, address).Scan(&a)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return a, err
}

// ---------------------------------------------------------------- sessions

func (d *DB) CreateSession(address string, ttl time.Duration) (string, error) {
	tok := Token("aws_")
	_, err := d.sql.Exec(`INSERT INTO sessions(hash, address, created_at, expires_at) VALUES(?,?,?,?)`,
		Hash(tok), address, now(), time.Now().UTC().Add(ttl).Format(time.RFC3339))
	return tok, err
}

func (d *DB) SessionAddress(token string) (string, error) {
	var addr, exp string
	err := d.sql.QueryRow(`SELECT address, expires_at FROM sessions WHERE hash=?`, Hash(token)).Scan(&addr, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if t, _ := time.Parse(time.RFC3339, exp); time.Now().After(t) {
		_, _ = d.sql.Exec(`DELETE FROM sessions WHERE hash=?`, Hash(token))
		return "", ErrNotFound
	}
	return addr, nil
}

func (d *DB) DeleteSession(token string) error {
	_, err := d.sql.Exec(`DELETE FROM sessions WHERE hash=?`, Hash(token))
	return err
}

func (d *DB) PruneSessions() { _, _ = d.sql.Exec(`DELETE FROM sessions WHERE expires_at < ?`, now()) }

// ---------------------------------------------------------------- agents

type Agent struct {
	ID        string
	Owner     string
	Name      string
	PublicKey string
	SecretEnc []byte
	RuleID    *uint32
	Status    string // pending | active | revoked
	CreatedAt string
}

func (d *DB) CreateAgent(a Agent) error {
	_, err := d.sql.Exec(`INSERT INTO agents(id, owner, name, public_key, secret_enc, rule_id, status, created_at) VALUES(?,?,?,?,?,?,?,?)`,
		a.ID, a.Owner, a.Name, a.PublicKey, a.SecretEnc, a.RuleID, a.Status, now())
	return err
}

func (d *DB) ActivateAgent(id string, ruleID uint32) error {
	_, err := d.sql.Exec(`UPDATE agents SET rule_id=?, status='active' WHERE id=?`, ruleID, id)
	return err
}

// SetAgentStatus marks an agent active or revoked (mirrors the on-chain rule).
func (d *DB) SetAgentStatus(id, status string) error {
	_, err := d.sql.Exec(`UPDATE agents SET status=? WHERE id=? AND status IN ('active','revoked')`, status, id)
	return err
}

func (d *DB) DeleteAgent(id string) error {
	_, err := d.sql.Exec(`DELETE FROM agents WHERE id=? AND status='pending'`, id)
	return err
}

func scanAgent(row interface{ Scan(...any) error }) (Agent, error) {
	var a Agent
	var rule sql.NullInt64
	err := row.Scan(&a.ID, &a.Owner, &a.Name, &a.PublicKey, &a.SecretEnc, &rule, &a.Status, &a.CreatedAt)
	if rule.Valid {
		r := uint32(rule.Int64)
		a.RuleID = &r
	}
	return a, err
}

const agentCols = `id, owner, name, public_key, secret_enc, rule_id, status, created_at`

func (d *DB) Agent(id string) (Agent, error) {
	a, err := scanAgent(d.sql.QueryRow(`SELECT `+agentCols+` FROM agents WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

func (d *DB) Agents(owner string) ([]Agent, error) {
	rows, err := d.sql.Query(`SELECT `+agentCols+` FROM agents WHERE owner=? AND status IN ('active','revoked') ORDER BY created_at`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Agent
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- API keys

type APIKey struct {
	Prefix     string  `json:"prefix"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
}

func (d *DB) CreateAPIKey(agentID string) (token, prefix string, err error) {
	token = Token("awk_")
	prefix = token[:12]
	_, err = d.sql.Exec(`INSERT INTO api_keys(hash, prefix, agent_id, created_at) VALUES(?,?,?,?)`, Hash(token), prefix, agentID, now())
	return token, prefix, err
}

func (d *DB) APIKeys(agentID string) ([]APIKey, error) {
	rows, err := d.sql.Query(`SELECT prefix, created_at, last_used_at FROM api_keys WHERE agent_id=? AND revoked_at IS NULL ORDER BY created_at`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		var k APIKey
		var used sql.NullString
		if err := rows.Scan(&k.Prefix, &k.CreatedAt, &used); err != nil {
			return nil, err
		}
		if used.Valid {
			k.LastUsedAt = &used.String
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (d *DB) RevokeAPIKey(agentID, prefix string) (bool, error) {
	r, err := d.sql.Exec(`UPDATE api_keys SET revoked_at=? WHERE agent_id=? AND prefix=? AND revoked_at IS NULL`, now(), agentID, prefix)
	if err != nil {
		return false, err
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// AgentByAPIKey resolves a bearer token to its active agent.
func (d *DB) AgentByAPIKey(token string) (Agent, error) {
	if !strings.HasPrefix(token, "awk_") {
		return Agent{}, ErrNotFound
	}
	h := Hash(token)
	a, err := scanAgent(d.sql.QueryRow(`SELECT a.`+strings.ReplaceAll(agentCols, ", ", ", a.")+` FROM api_keys k JOIN agents a ON a.id=k.agent_id
		WHERE k.hash=? AND k.revoked_at IS NULL AND a.status='active'`, h))
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	if err == nil {
		_, _ = d.sql.Exec(`UPDATE api_keys SET last_used_at=? WHERE hash=?`, now(), h)
	}
	return a, err
}

// ---------------------------------------------------------------- payments

type Payment struct {
	Hash           string        `json:"hash"`
	URL            string        `json:"url"`
	AgentID        string        `json:"agent_id"`
	AgentName      string        `json:"agent_name,omitempty"`
	To             string        `json:"to"`
	Amount         string        `json:"amount"`
	Asset          string        `json:"asset"`
	Memo           string        `json:"memo,omitempty"`
	Status         string        `json:"status"`
	Error          *wallet.Error `json:"error"`
	Ledger         uint32        `json:"ledger"`
	CreatedAt      string        `json:"created_at"`
	IdempotencyKey string        `json:"idempotency_key,omitempty"`
	Source         string        `json:"source,omitempty"`
}

func (d *DB) AddPayment(owner string, p Payment) error {
	var errJSON *string
	if p.Error != nil {
		b, _ := json.Marshal(p.Error)
		s := string(b)
		errJSON = &s
	}
	if p.CreatedAt == "" {
		p.CreatedAt = now()
	}
	var idem *string
	if p.IdempotencyKey != "" {
		idem = &p.IdempotencyKey
	}
	_, err := d.sql.Exec(`INSERT INTO payments(hash, url, agent_id, owner, to_addr, amount, asset, memo, status, error, ledger, created_at, idempotency_key, source)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, p.Hash, p.URL, p.AgentID, owner, p.To, p.Amount, p.Asset, p.Memo, p.Status, errJSON, p.Ledger, p.CreatedAt, idem, p.Source)
	return err
}

// Payments lists the owner's payments, optionally for one agent, newest first.
func (d *DB) Payments(owner, agentID, idem string, limit int) ([]Payment, error) {
	q := `SELECT p.hash, p.url, p.agent_id, COALESCE(a.name,''), p.to_addr, p.amount, p.asset, COALESCE(p.memo,''), p.status, p.error, COALESCE(p.ledger,0), p.created_at, COALESCE(p.idempotency_key,''), COALESCE(p.source,'')
		FROM payments p LEFT JOIN agents a ON a.id=p.agent_id WHERE p.owner=?`
	args := []any{owner}
	if agentID != "" {
		q += ` AND p.agent_id=?`
		args = append(args, agentID)
	}
	if idem != "" {
		q += ` AND p.idempotency_key=?`
		args = append(args, idem)
	}
	q += ` ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`
	args = append(args, limit)
	rows, err := d.sql.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Payment{}
	for rows.Next() {
		var p Payment
		var errJSON sql.NullString
		if err := rows.Scan(&p.Hash, &p.URL, &p.AgentID, &p.AgentName, &p.To, &p.Amount, &p.Asset, &p.Memo, &p.Status, &errJSON, &p.Ledger, &p.CreatedAt, &p.IdempotencyKey, &p.Source); err != nil {
			return nil, err
		}
		if errJSON.Valid {
			p.Error = &wallet.Error{}
			_ = json.Unmarshal([]byte(errJSON.String), p.Error)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) PaymentCount(agentID string) int {
	var n int
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM payments WHERE agent_id=?`, agentID).Scan(&n)
	return n
}

// AgentLog is the payment log of one agent (implements tools.Log).
type AgentLog struct {
	DB      *DB
	Owner   string
	AgentID string
}

func (l AgentLog) Add(p Payment) error {
	p.AgentID = l.AgentID
	return l.DB.AddPayment(l.Owner, p)
}

func (l AgentLog) Recent(n int) []Payment {
	ps, _ := l.DB.Payments(l.Owner, l.AgentID, "", n)
	return ps
}

func (l AgentLog) ByIdempotencyKey(key string) (Payment, bool) {
	if key == "" {
		return Payment{}, false
	}
	ps, err := l.DB.Payments(l.Owner, l.AgentID, key, 1)
	if err != nil || len(ps) == 0 {
		return Payment{}, false
	}
	return ps[0], true
}

// ---------------------------------------------------------------- daily quotas

// Day is the UTC day quotas are counted in.
func Day(t time.Time) string { return t.UTC().Format("2006-01-02") }

// Use counts one use of key today if fewer than limit were counted; ok is
// false (and nothing is counted) once the limit is reached. Counters live in
// the db so a restart doesn't reset them.
func (d *DB) Use(key string, limit int) (used int, ok bool, err error) {
	if limit <= 0 {
		return 0, true, nil // unlimited
	}
	day := Day(time.Now())
	err = d.sql.QueryRow(`INSERT INTO usage(day, key, n) VALUES(?, ?, 1)
		ON CONFLICT(day, key) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n`, day, key, limit).Scan(&used)
	if errors.Is(err, sql.ErrNoRows) {
		return limit, false, nil
	}
	return used, err == nil, err
}

// Used is today's count for key.
func (d *DB) Used(key string) int {
	var n int
	_ = d.sql.QueryRow(`SELECT n FROM usage WHERE day=? AND key=?`, Day(time.Now()), key).Scan(&n)
	return n
}

// PruneUsage drops counters older than a week.
func (d *DB) PruneUsage() {
	_, _ = d.sql.Exec(`DELETE FROM usage WHERE day < ?`, Day(time.Now().AddDate(0, 0, -7)))
}

// CountAgents counts an owner's agents, pending ones included.
func (d *DB) CountAgents(owner string) int {
	var n int
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM agents WHERE owner=?`, owner).Scan(&n)
	return n
}

// CountAPIKeys counts an agent's active API keys.
func (d *DB) CountAPIKeys(agentID string) int {
	var n int
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM api_keys WHERE agent_id=? AND revoked_at IS NULL`, agentID).Scan(&n)
	return n
}

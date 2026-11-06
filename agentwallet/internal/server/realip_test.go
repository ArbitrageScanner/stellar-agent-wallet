package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRealIP(t *testing.T) {
	var got string
	h := realIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = clientIP(r) }))
	for _, c := range []struct{ xff, want string }{
		{"", "10.0.0.9"},                        // no header: proxy address
		{"203.0.113.7", "203.0.113.7"},          // set by the proxy
		{"1.2.3.4, 203.0.113.7", "203.0.113.7"}, // client-supplied prefix is ignored
		{"2001:db8::1", "[2001:db8::1]"},        // IPv6
		{"not-an-ip", "10.0.0.9"},               // garbage: unchanged
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "10.0.0.9:5555"
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		h.ServeHTTP(httptest.NewRecorder(), r)
		if got != c.want {
			t.Errorf("XFF %q: clientIP = %q, want %q", c.xff, got, c.want)
		}
	}
}

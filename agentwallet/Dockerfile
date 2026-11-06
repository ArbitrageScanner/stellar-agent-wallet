FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/agentwallet ./cmd/agentwallet

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/agentwallet /agentwallet
# Secrets: mount the master key as a file (MASTER_KEY_FILE) or pass MASTER_KEY;
# the keystore and database live in /data and are useless without it.
ENV LISTEN=:8090 DB_FILE=/data/agentwallet.db KEYSTORE_FILE=/data/keystore.enc \
    MASTER_KEY_FILE=/run/secrets/agentwallet_master_key DEPLOYMENT_FILE=/config/deployment.json
EXPOSE 8090
VOLUME ["/data"]
ENTRYPOINT ["/agentwallet"]
CMD ["serve"]

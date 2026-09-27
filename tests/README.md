# Tests

This directory contains test-only assets. The main Docker stack in
`docker/testnet/docker-compose.yml` only starts the service containers.

Start the service stack:

```bash
docker compose -f docker/testnet/docker-compose.yml up -d --build
```

Run the WSS acceptance suite:

```bash
docker compose -f docker/testnet/docker-compose.yml -f tests/docker-compose.yml --profile test run --rm wss-test
```

The suite fails if `hello` does not report the reset-testnet genesis
(`TEST_EXPECTED_GENESIS`, empty to skip). Happy-path address and asset tests
run only when `TEST_ADDRESS`, `TEST_ASSET_ADDRESS` and `TEST_ASSET_NAME` are
set in `docker/testnet/.env` to funded addresses on the reset testnet.

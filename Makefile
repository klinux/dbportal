# dbportal - local development.
#
#   make dev      database up, app in the foreground (Ctrl+C stops the app)
#   make stop     app and database down
#
# The database is the `postgres` service of database-compose.yml (the file the integration
# suite uses too, so one container serves both): it is the dev database the seed file points
# at and the server store (STORAGE_PROVIDER=postgres in .env.local). Everything else is
# `bun run` scripts from package.json.

COMPOSE      ?= docker compose
DB_COMPOSE   ?= database-compose.yml
DB_SERVICE   ?= postgres
DB_CONTAINER ?= libredb-postgres
PORT         ?= 3000

.PHONY: help env dev dev-bg stop db-up db-down db-reset status logs check test coverage

help: ## list the targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

env: ## create .env.local from the example if it does not exist
	@if [ -f .env.local ]; then echo ".env.local exists"; else cp .env.example .env.local && echo "created .env.local - set JWT_SECRET and ADMIN_PASSWORD at least"; fi

dev: db-up ## database up, then the app in the foreground on http://localhost:3000 (PORT=… to change)
	@[ -f .env.local ] || { echo "no .env.local - run 'make env' first"; exit 1; }
	bun run dev

dev-bg: db-up ## the same, detached; log in .dev.log, pid in .dev.pid
	@[ -f .env.local ] || { echo "no .env.local - run 'make env' first"; exit 1; }
	@if [ -n "$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null)" ]; then echo "port $(PORT) is already in use"; exit 1; fi
	@nohup bun run dev > .dev.log 2>&1 & echo $$! > .dev.pid
	@until grep -q "Ready in" .dev.log 2>/dev/null; do sleep 1; done
	@echo "dev server on http://localhost:$(PORT) (log: .dev.log, stop: make stop)"

stop: ## stop the app (foreground or detached) and the database
	@if [ -f .dev.pid ]; then kill "$$(cat .dev.pid)" 2>/dev/null || true; rm -f .dev.pid; fi
	@pids="$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null)"; if [ -n "$$pids" ]; then kill $$pids; echo "stopped the app on port $(PORT)"; fi
	$(COMPOSE) -f $(DB_COMPOSE) down

db-up: ## start PostgreSQL and wait until it answers
	$(COMPOSE) -f $(DB_COMPOSE) up -d $(DB_SERVICE)
	@until docker exec $(DB_CONTAINER) pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
	@echo "postgres ready on localhost:5432"

db-down: ## stop PostgreSQL, keep its data
	$(COMPOSE) -f $(DB_COMPOSE) down

db-reset: ## stop PostgreSQL and drop its data, then start it clean
	$(COMPOSE) -f $(DB_COMPOSE) down -v
	$(MAKE) db-up

status: ## what is running
	@$(COMPOSE) -f $(DB_COMPOSE) ps
	@pids="$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null)"; if [ -n "$$pids" ]; then echo "app: listening on :$(PORT) (pid $$pids)"; else echo "app: not running"; fi

logs: ## follow the database log (the detached app logs to .dev.log)
	$(COMPOSE) -f $(DB_COMPOSE) logs -f $(DB_SERVICE)

check: ## lint and typecheck
	bun run lint
	bun run typecheck

test: ## the whole suite, the way CI runs it
	bun run test:ci

coverage: ## the 100% line-coverage gate
	rm -rf coverage
	bun run test:coverage:core || true
	bun run test:components:coverage
	node scripts/merge-lcov.mjs coverage/core/file-*/lcov.info coverage/components/lcov.info coverage/lcov.info
	bun run coverage:check

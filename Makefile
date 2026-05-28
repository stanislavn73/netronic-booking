.PHONY: install up down migrate seed dev test reset

install:
	pnpm install

up:
	docker compose up -d postgres
	@echo "Waiting for Postgres..."
	@until docker exec netronic-postgres pg_isready -U booking >/dev/null 2>&1; do sleep 1; done
	@echo "Postgres ready"

down:
	docker compose down

migrate:
	pnpm --filter @app/api migrate

seed:
	pnpm --filter @app/api seed

dev:
	pnpm -r --parallel dev

test:
	pnpm --filter @app/api test

reset:
	docker compose down -v
	$(MAKE) up
	$(MAKE) migrate
	$(MAKE) seed

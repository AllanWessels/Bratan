.PHONY: help sync ui ui-backend ui-frontend ingest eval loop lint test format clean

UV := uv

help:
	@echo "RAG Refiner — make targets"
	@echo "  sync          Install/refresh Python deps with uv"
	@echo "  ui            Launch the FastAPI backend + Vite frontend (dev mode)"
	@echo "  ui-backend    Backend only (port 8000)"
	@echo "  ui-frontend   Frontend only (port 5173, proxies to backend)"
	@echo "  ingest        Build the vector index from /corpus/"
	@echo "  eval          Run the judge over all test cases"
	@echo "  loop          Run one red->blue->judge iteration"
	@echo "  lint          ruff check + mypy"
	@echo "  format        ruff format"
	@echo "  test          pytest"
	@echo "  clean         Remove caches and build artifacts"

sync:
	$(UV) sync --all-extras

ui:
	@echo "Backend:  http://127.0.0.1:8000"
	@echo "Frontend: http://127.0.0.1:5173"
	$(UV) run python scripts/serve_ui.py

ui-backend:
	$(UV) run uvicorn ui.backend.app:app --host 127.0.0.1 --port 8000 --reload

ui-frontend:
	cd ui/frontend && npm run dev

ingest:
	$(UV) run python -m pipeline.ingest

eval:
	$(UV) run python scripts/eval.py

loop:
	$(UV) run python scripts/loop.py --iterations 1

lint:
	$(UV) run ruff check .
	$(UV) run mypy pipeline ui/backend scripts

format:
	$(UV) run ruff format .
	$(UV) run ruff check . --fix

test:
	$(UV) run pytest -q

clean:
	rm -rf .pytest_cache .ruff_cache .mypy_cache .cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +

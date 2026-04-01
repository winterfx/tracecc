.PHONY: install start stop report clean

install: ## Install dependencies
	npm install

start: ## Start server
	node server.js

stop: ## Kill running server
	@lsof -ti:3001 | xargs kill -9 2>/dev/null || true

report: ## Generate report from latest log
	@LOG=$$(ls -t *.jsonl 2>/dev/null | head -1); \
	if [ -z "$$LOG" ]; then echo "No .jsonl files found"; exit 1; fi; \
	echo "Generating report from $$LOG..."; \
	node generate-report.js "$$LOG"

clean: ## Remove generated files and node_modules
	rm -f test-*.html
	rm -rf node_modules

# Keel — thin wrappers over npm scripts, for people who type `make` first.
.PHONY: setup doctor test test-unit test-contracts backtest chainstate fmt clean

setup:          ; npm run setup
doctor:         ; npm run doctor
test:           ; npm test
test-unit:      ; npm run test:unit
test-contracts: ; npm run test:contracts
backtest:       ; npm run backtest
chainstate:     ; npm run chainstate
fmt:            ; forge fmt --root contracts
clean:          ; git clean -xfd contracts/out contracts/cache frontend/.next

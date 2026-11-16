-- gateway-llm 0007: a test call can be stopped by the outbound guard (review of Phases 27 and 28, M5). Forward-only: never edit once applied.
--
-- The setup page's test call goes through the model proxy, which opens the connection from inside the cluster. A provider's base URL that points inside the network or at a
-- cloud metadata service is now refused before the call is made, and the result says so with its own cause instead of "other". The cause list gains `address_blocked`.

ALTER TABLE app.llm_alias_tests DROP CONSTRAINT llm_alias_tests_cause_check;
ALTER TABLE app.llm_alias_tests ADD CONSTRAINT llm_alias_tests_cause_check
  CHECK (cause IN ('no_gateway', 'unbound', 'refused', 'address_blocked', 'auth', 'model_not_found', 'rate_limited', 'provider_error', 'timeout', 'unreachable', 'empty_answer', 'other'));

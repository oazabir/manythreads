-- channels 0018: a transcript written by the server is not an edit (P32-02, decision D13). Forward-only: never edit once applied.
--
-- A voice message is posted with a stand-in line as its body ("Voice message (0:42)"); the server replaces it with the words once the speech model has
-- answered (P32-04). That write changes `body` but not `edited_at` (the message must not show an "edited" mark). The trigger of 0009 keeps the old
-- body as an earlier version whenever the body changes, so the stand-in line would show up in "Earlier versions" of every voice message.
--
-- The trigger now fires for a body change only when `edited_at` changed with it. Every real edit (editChannelMessage, the author's or a bot's) sets
-- `edited_at = now()`, so edits keep their history exactly as before; a deletion still clears the history. The function `app.messages_keep_version()`
-- is not touched (it belongs to manythreads_system; the condition lives in the trigger, which the table's owner may replace).
DROP TRIGGER messages_keep_version ON app.messages;
CREATE TRIGGER messages_keep_version AFTER UPDATE OF body, deleted_at ON app.messages FOR EACH ROW
  WHEN ((OLD.body IS DISTINCT FROM NEW.body AND OLD.edited_at IS DISTINCT FROM NEW.edited_at) OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
  EXECUTE FUNCTION app.messages_keep_version();

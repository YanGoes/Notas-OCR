"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { fazerBackup } = require("../src/backup");

test("backup diario copia o banco consistente, uma vez por dia, e apaga os antigos", async () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);");
    fs.mkdirSync(path.join(pasta, "2026-09-01"));
    const primeiro = await fazerBackup(db, { pasta, hoje: new Date("2026-10-14T12:00:00"), cadastros: [] });
    assert.equal(primeiro.feito, true);
    assert.deepEqual(primeiro.removidos, ["2026-09-01"]);
    const copia = new DatabaseSync(path.join(primeiro.destino, "central.db"));
    assert.equal(copia.prepare("SELECT x FROM t").get().x, 42);
    copia.close();
    const segundo = await fazerBackup(db, { pasta, hoje: new Date("2026-10-14T18:00:00"), cadastros: [] });
    assert.equal(segundo.feito, false, "so um backup por dia");
    fs.rmSync(pasta, { recursive: true, force: true });
});

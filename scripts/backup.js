#!/usr/bin/env node
/** Tar en sikkerhetskopi nå, uten å vente på nattjobben. */
import { backupDatabase } from '../src/jobs.js';
import { closeDb } from '../src/db.js';

const result = await backupDatabase();
console.log(JSON.stringify(result, null, 2));
closeDb();

#!/usr/bin/env node
'use strict';

// Copies the shared core (extension/lib/core.js) into the companion app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'extension', 'lib', 'core.js');
const dest = path.join(root, 'companion', 'src', 'core.js');
fs.copyFileSync(src, dest);
console.log('copied', path.relative(root, src), '->', path.relative(root, dest));

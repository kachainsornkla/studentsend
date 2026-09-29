<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';
if (PHP_SAPI !== 'cli' || $argc < 3) { fwrite(STDERR, "Usage: php tools/create_user.php USERNAME DISPLAY_NAME\n"); exit(1); }
$password = getenv('STUDENTSEND_INITIAL_PASSWORD') ?: '';
if (strlen($password) < 12) { fwrite(STDERR, "Set STUDENTSEND_INITIAL_PASSWORD to a password of at least 12 characters.\n"); exit(1); }
$stmt = db()->prepare('INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,\'admin\')');
$stmt->execute([$argv[1], password_hash($password, PASSWORD_DEFAULT), $argv[2]]);
fwrite(STDOUT, "User created. Store the password safely and remove it from the environment.\n");

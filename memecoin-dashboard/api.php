<?php
/**
 * Token add/remove/reorder API. Reads and writes config.json.
 * Format: {"tokens": [{"address": "CA1", "order": 0}, {"address": "CA2", "order": 1}]}
 *
 * POST api.php?action=add&token=CA_ADDRESS
 * POST api.php?action=remove&token=CA_ADDRESS
 * POST api.php?action=reorder&order=CA1,CA2,CA3  (comma-separated addresses, new order)
 *
 * Returns JSON: { "ok": true, "tokens": [...] } or { "ok": false, "error": "..." }
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

$configPath = __DIR__ . '/config.json';

function normalizeToken($t) {
    if (is_string($t)) {
        $s = trim($t);
        return (strlen($s) > 0) ? ['address' => $s, 'order' => 0] : null;
    }
    if (is_array($t) && isset($t['address']) && is_string($t['address'])) {
        $addr = trim($t['address']);
        if (strlen($addr) === 0) return null;
        $order = isset($t['order']) && is_numeric($t['order']) ? (int) $t['order'] : 0;
        return ['address' => $addr, 'order' => $order];
    }
    return null;
}

function loadConfig($path) {
    $default = ['tokens' => []];
    if (!file_exists($path)) {
        @file_put_contents($path, json_encode($default, JSON_PRETTY_PRINT));
        return $default;
    }
    $raw = @file_get_contents($path);
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data) || !isset($data['tokens'])) {
        return $default;
    }
    $out = [];
    foreach ($data['tokens'] as $i => $t) {
        $n = normalizeToken($t);
        if ($n) $out[] = $n;
    }
    usort($out, function ($a, $b) { return $a['order'] - $b['order']; });
    foreach ($out as $i => &$e) {
        $e['order'] = $i;
    }
    return ['tokens' => array_values($out)];
}

function saveConfig($path, $data) {
    $tokens = $data['tokens'];
    foreach ($tokens as $i => &$e) {
        $e['order'] = $i;
    }
    return @file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT)) !== false;
}

$action = isset($_GET['action']) ? trim($_GET['action']) : '';
$token  = isset($_GET['token'])  ? trim($_GET['token'])  : '';
$order  = isset($_GET['order'])  ? trim($_GET['order'])  : '';

$config = loadConfig($configPath);
$tokens = &$config['tokens'];

function addressesFromTokens($arr) {
    return array_map(function ($t) { return $t['address']; }, $arr);
}

if ($action === 'reorder') {
    if ($order === '') {
        echo json_encode(['ok' => false, 'error' => 'Missing order']);
        exit;
    }
    $requested = array_map('trim', array_filter(explode(',', $order)));
    $currentAddrs = addressesFromTokens($tokens);
    $currentSet = array_flip($currentAddrs);
    $newList = [];
    foreach ($requested as $addr) {
        if (isset($currentSet[$addr])) {
            $newList[] = ['address' => $addr, 'order' => count($newList)];
        }
    }
    foreach ($currentAddrs as $addr) {
        if (!in_array($addr, $requested, true)) {
            $newList[] = ['address' => $addr, 'order' => count($newList)];
        }
    }
    $config['tokens'] = $newList;
    if (!saveConfig($configPath, $config)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save config', 'tokens' => loadConfig($configPath)['tokens']]);
        exit;
    }
    echo json_encode(['ok' => true, 'tokens' => loadConfig($configPath)['tokens']]);
    exit;
}

if ($action === '' || $token === '') {
    echo json_encode(['ok' => false, 'error' => 'Missing action or token']);
    exit;
}

if (strlen($token) < 20 || strlen($token) > 66) {
    echo json_encode(['ok' => false, 'error' => 'Invalid token address']);
    exit;
}

$addrs = addressesFromTokens($tokens);

if ($action === 'add') {
    if (in_array($token, $addrs, true)) {
        echo json_encode(['ok' => false, 'error' => 'Token already added', 'tokens' => $config['tokens']]);
        exit;
    }
    $maxOrder = count($tokens) === 0 ? -1 : max(array_column($tokens, 'order'));
    $tokens[] = ['address' => $token, 'order' => $maxOrder + 1];
    if (!saveConfig($configPath, $config)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save config', 'tokens' => loadConfig($configPath)['tokens']]);
        exit;
    }
    echo json_encode(['ok' => true, 'tokens' => loadConfig($configPath)['tokens']]);
    exit;
}

if ($action === 'remove') {
    $tokens = array_values(array_filter($tokens, function ($t) use ($token) { return $t['address'] !== $token; }));
    if (!saveConfig($configPath, $config)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save config', 'tokens' => loadConfig($configPath)['tokens']]);
        exit;
    }
    echo json_encode(['ok' => true, 'tokens' => loadConfig($configPath)['tokens']]);
    exit;
}

echo json_encode(['ok' => false, 'error' => 'Invalid action', 'tokens' => $config['tokens']]);

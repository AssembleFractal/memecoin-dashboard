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

$action = isset($_GET['action']) ? trim($_GET['action']) : '';

$alertsPath = __DIR__ . '/alerts.json';
$historyPath = __DIR__ . '/history.json';

function loadJson($path, $default) {
    if (!file_exists($path)) {
        return $default;
    }
    $raw = @file_get_contents($path);
    $data = $raw ? json_decode($raw, true) : null;
    return is_array($data) ? $data : $default;
}

function saveJson($path, $data) {
    return @file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT)) !== false;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'getAlerts') {
    $data = loadJson($alertsPath, ['alerts' => []]);
    echo json_encode(['ok' => true, 'alerts' => isset($data['alerts']) ? $data['alerts'] : []]);
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

$token  = isset($_GET['token'])  ? trim($_GET['token'])  : '';
$order  = isset($_GET['order'])  ? trim($_GET['order'])  : '';
$input  = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];

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

if ($action === 'saveAlert') {
    $addr = isset($input['tokenAddress']) ? trim($input['tokenAddress']) : '';
    $symbol = isset($input['tokenSymbol']) ? trim($input['tokenSymbol']) : '—';
    $targetPrice = isset($input['targetPrice']) ? (float) $input['targetPrice'] : 0;
    if ($addr === '' || strlen($addr) < 20) {
        echo json_encode(['ok' => false, 'error' => 'Invalid token address']);
        exit;
    }
    if ($targetPrice <= 0) {
        echo json_encode(['ok' => false, 'error' => 'Target price must be greater than 0']);
        exit;
    }
    $data = loadJson($alertsPath, ['alerts' => []]);
    $alerts = isset($data['alerts']) ? $data['alerts'] : [];
    $id = bin2hex(random_bytes(8));
    $alerts[] = [
        'id' => $id,
        'tokenAddress' => $addr,
        'tokenSymbol' => $symbol,
        'targetPrice' => $targetPrice,
        'createdAt' => time(),
        'lastPrice' => null,
    ];
    $data['alerts'] = $alerts;
    $saveResult = saveJson($alertsPath, $data);
    if (!$saveResult) {
        $errorMsg = 'Failed to save alerts.json';
        if (!is_writable($alertsPath) && file_exists($alertsPath)) {
            $errorMsg .= ' (file not writable)';
        } elseif (!is_writable(dirname($alertsPath))) {
            $errorMsg .= ' (directory not writable)';
        }
        error_log('saveAlert failed: ' . $errorMsg);
        echo json_encode(['ok' => false, 'error' => $errorMsg]);
        exit;
    }
    echo json_encode(['ok' => true, 'alerts' => $data['alerts']]);
    exit;
}

if ($action === 'deleteAlert') {
    $alertId = isset($input['alertId']) ? trim($input['alertId']) : '';
    if ($alertId === '') {
        echo json_encode(['ok' => false, 'error' => 'Missing alertId']);
        exit;
    }
    $data = loadJson($alertsPath, ['alerts' => []]);
    $alerts = isset($data['alerts']) ? $data['alerts'] : [];
    $data['alerts'] = array_values(array_filter($alerts, function ($a) use ($alertId) {
        return isset($a['id']) && $a['id'] !== $alertId;
    }));
    if (!saveJson($alertsPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'alerts' => $data['alerts']]);
    exit;
}

if ($action === 'addHistory') {
    $triggeredAt = time();
    $item = [
        'id' => bin2hex(random_bytes(8)),
        'tokenAddress' => isset($input['tokenAddress']) ? trim($input['tokenAddress']) : '',
        'tokenSymbol' => isset($input['tokenSymbol']) ? trim($input['tokenSymbol']) : '—',
        'targetPrice' => isset($input['targetPrice']) ? (float) $input['targetPrice'] : 0,
        'actualPrice' => isset($input['actualPrice']) ? (float) $input['actualPrice'] : 0,
        'triggeredAt' => $triggeredAt,
        'read' => false,
        'type' => isset($input['type']) ? trim($input['type']) : '',
        'note' => isset($input['note']) ? trim($input['note']) : '',
    ];
    $data = loadJson($historyPath, ['items' => [], 'unreadCount' => 0]);
    $items = isset($data['items']) ? $data['items'] : [];
    array_unshift($items, $item);
    $data['items'] = array_slice($items, 0, 500);
    $data['unreadCount'] = (isset($data['unreadCount']) ? (int) $data['unreadCount'] : 0) + 1;
    if (!saveJson($historyPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'items' => $data['items'], 'unreadCount' => $data['unreadCount']]);
    exit;
}

if ($action === 'markHistoryRead') {
    $data = loadJson($historyPath, ['items' => [], 'unreadCount' => 0]);
    $items = isset($data['items']) ? $data['items'] : [];
    $id = isset($input['id']) ? trim($input['id']) : null;
    if ($id) {
        foreach ($items as &$it) {
            if (isset($it['id']) && $it['id'] === $id) {
                $it['read'] = true;
                $data['unreadCount'] = max(0, (isset($data['unreadCount']) ? (int) $data['unreadCount'] : 0) - 1);
                break;
            }
        }
    } else {
        foreach ($items as &$it) {
            $it['read'] = true;
        }
        $data['unreadCount'] = 0;
    }
    $data['items'] = $items;
    if (!saveJson($historyPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'items' => $data['items'], 'unreadCount' => $data['unreadCount']]);
    exit;
}

if ($action === 'getHistory') {
    $data = loadJson($historyPath, ['items' => [], 'unreadCount' => 0]);
    $items = isset($data['items']) ? $data['items'] : [];
    $unreadCount = isset($data['unreadCount']) ? (int) $data['unreadCount'] : 0;
    echo json_encode(['ok' => true, 'items' => $items, 'unreadCount' => $unreadCount]);
    exit;
}

if ($action === 'deleteHistoryItem') {
    $itemId = isset($input['id']) ? trim($input['id']) : '';
    if ($itemId === '') {
        echo json_encode(['ok' => false, 'error' => 'Missing id']);
        exit;
    }
    $data = loadJson($historyPath, ['items' => [], 'unreadCount' => 0]);
    $items = isset($data['items']) ? $data['items'] : [];
    $unreadCount = isset($data['unreadCount']) ? (int) $data['unreadCount'] : 0;
    $found = false;
    $wasUnread = false;
    foreach ($items as $idx => $it) {
        if (isset($it['id']) && $it['id'] === $itemId) {
            $wasUnread = !isset($it['read']) || !$it['read'];
            array_splice($items, $idx, 1);
            $found = true;
            break;
        }
    }
    if (!$found) {
        echo json_encode(['ok' => false, 'error' => 'Item not found']);
        exit;
    }
    if ($wasUnread) {
        $unreadCount = max(0, $unreadCount - 1);
    }
    $data['items'] = $items;
    $data['unreadCount'] = $unreadCount;
    if (!saveJson($historyPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'items' => $data['items'], 'unreadCount' => $data['unreadCount']]);
    exit;
}

if ($action === 'clearAllHistory') {
    $data = ['items' => [], 'unreadCount' => 0];
    if (!saveJson($historyPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'items' => [], 'unreadCount' => 0]);
    exit;
}

if ($action === 'deleteAlert') {
    $alertId = isset($input['alertId']) ? trim($input['alertId']) : '';
    if ($alertId === '') {
        echo json_encode(['ok' => false, 'error' => 'Missing alertId']);
        exit;
    }
    $data = loadJson($alertsPath, ['alerts' => []]);
    $alerts = isset($data['alerts']) ? $data['alerts'] : [];
    $data['alerts'] = array_values(array_filter($alerts, function ($a) use ($alertId) {
        return isset($a['id']) && $a['id'] !== $alertId;
    }));
    if (!saveJson($alertsPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'alerts' => $data['alerts']]);
    exit;
}

if ($action === 'updateAlertLastPrice') {
    $alertId = isset($input['alertId']) ? trim($input['alertId']) : '';
    $lastPrice = isset($input['lastPrice']) ? (float) $input['lastPrice'] : null;
    if ($alertId === '') {
        echo json_encode(['ok' => false, 'error' => 'Missing alertId']);
        exit;
    }
    $data = loadJson($alertsPath, ['alerts' => []]);
    $alerts = isset($data['alerts']) ? $data['alerts'] : [];
    foreach ($alerts as &$a) {
        if (isset($a['id']) && $a['id'] === $alertId) {
            $a['lastPrice'] = $lastPrice;
            break;
        }
    }
    $data['alerts'] = $alerts;
    if (!saveJson($alertsPath, $data)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to save']);
        exit;
    }
    echo json_encode(['ok' => true, 'alerts' => $data['alerts']]);
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

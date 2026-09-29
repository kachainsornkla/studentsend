<?php
declare(strict_types=1);

$config = require dirname(__DIR__) . '/config/config.php';
date_default_timezone_set($config['timezone']);
if (session_status() !== PHP_SESSION_ACTIVE) {
    session_name('studentsend_session');
    session_set_cookie_params(['httponly' => true, 'secure' => !empty($_SERVER['HTTPS']), 'samesite' => 'Lax']);
    session_start();
}

function db(): PDO {
    global $config;
    static $pdo;
    if (!$pdo) {
        $d = $config['db'];
        $pdo = new PDO("mysql:host={$d['host']};port={$d['port']};dbname={$d['database']};charset={$d['charset']}", $d['username'], $d['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }
    return $pdo;
}
function e(mixed $value): string { return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function csrf(): string { if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32)); return $_SESSION['csrf']; }
function verify_csrf(): void {
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['_csrf'] ?? '');
    if (!is_string($token) || !hash_equals(csrf(), $token)) json_response(['error' => 'Invalid CSRF token'], 419);
}
function require_auth(): void { if (empty($_SESSION['user_id'])) json_response(['error' => 'Authentication required'], 401); }
function json_response(array $data, int $status = 200): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit;
}
function body_json(): array { $data = json_decode(file_get_contents('php://input'), true); return is_array($data) ? $data : []; }
function valid_token(): string { return bin2hex(random_bytes(16)); }
function api(): void {
    $action = (string)($_GET['api'] ?? '');
    if ($action === 'login') {
        verify_csrf(); $data = body_json();
        $stmt = db()->prepare('SELECT id,password_hash,display_name FROM users WHERE username=? AND active=1');
        $stmt->execute([trim((string)($data['username'] ?? ''))]); $user = $stmt->fetch();
        if (!$user || !password_verify((string)($data['password'] ?? ''), $user['password_hash'])) json_response(['error'=>'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'], 422);
        session_regenerate_id(true); $_SESSION['user_id'] = (int)$user['id']; $_SESSION['display_name'] = $user['display_name'];
        json_response(['ok'=>true]);
    }
    if ($action === 'logout') { verify_csrf(); $_SESSION=[]; session_regenerate_id(true); json_response(['ok'=>true]); }
    require_auth();
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') verify_csrf();
    $pdo = db();
    try {
        switch ($action) {
            case 'dashboard':
                $counts = $pdo->query("SELECT (SELECT COUNT(*) FROM students WHERE status='active') students,(SELECT COUNT(*) FROM assignments WHERE status='active') assignments,(SELECT COUNT(*) FROM submissions) total,(SELECT COUNT(*) FROM submissions WHERE status IN ('submitted','checking','checked','returned','late')) received,(SELECT COUNT(*) FROM submissions WHERE status='pending') pending,(SELECT COUNT(*) FROM submissions WHERE status='checking') checking,(SELECT COUNT(*) FROM submissions WHERE status='checked') checked")->fetch();
                $byAssignment = $pdo->query("SELECT a.id,a.assignment_code,a.assignment_name,a.subject,a.due_date,COUNT(s.id) total,SUM(s.status<>'pending') received,SUM(s.status='pending') pending,SUM(s.status='checking') checking FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id WHERE a.status='active' GROUP BY a.id ORDER BY a.due_date IS NULL,a.due_date DESC,a.id DESC")->fetchAll();
                json_response(['counts'=>$counts,'assignments'=>$byAssignment]);
            case 'students':
                $q=trim((string)($_GET['q']??'')); $stmt=$pdo->prepare("SELECT s.*,COUNT(CASE WHEN sub.status<>'pending' THEN 1 END) submitted,COUNT(sub.id) total FROM students s LEFT JOIN submissions sub ON sub.student_id=s.id WHERE (?='' OR s.student_code LIKE ? OR s.student_name LIKE ? OR s.class_name LIKE ?) GROUP BY s.id ORDER BY s.class_name,s.student_number,s.student_name LIMIT 500"); $like="%$q%"; $stmt->execute([$q,$like,$like,$like]); json_response($stmt->fetchAll());
            case 'assignments':
                $q=trim((string)($_GET['q']??'')); $stmt=$pdo->prepare("SELECT a.*,COUNT(s.id) total,SUM(s.status<>'pending') received FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id WHERE (?='' OR a.assignment_code LIKE ? OR a.assignment_name LIKE ? OR a.subject LIKE ?) GROUP BY a.id ORDER BY a.id DESC LIMIT 500"); $like="%$q%"; $stmt->execute([$q,$like,$like,$like]); json_response($stmt->fetchAll());
            case 'save_student':
                $d=body_json(); $id=(int)($d['id']??0); $code=trim((string)($d['student_code']??'')); $name=trim((string)($d['student_name']??''));
                if ($code===''||$name==='') json_response(['error'=>'กรุณากรอกรหัสและชื่อนักเรียน'],422);
                if ($id) { $st=$pdo->prepare('UPDATE students SET student_code=?,student_name=?,class_name=?,student_number=?,status=? WHERE id=?'); $st->execute([$code,$name,$d['class_name']?:null,($d['student_number']??'')===''?null:(int)$d['student_number'],$d['status']??'active',$id]); }
                else { $st=$pdo->prepare('INSERT INTO students(student_code,student_name,class_name,student_number,qr_token) VALUES(?,?,?,?,?)'); $st->execute([$code,$name,$d['class_name']?:null,($d['student_number']??'')===''?null:(int)$d['student_number'],valid_token()]); $id=(int)$pdo->lastInsertId(); }
                if (($d['status']??'active')==='active') $pdo->exec("INSERT IGNORE INTO submissions(student_id,assignment_id,status) SELECT ".(int)$id.",id,'pending' FROM assignments WHERE status='active'");
                json_response(['ok'=>true]);
            case 'delete_student':
                $st=$pdo->prepare('DELETE FROM students WHERE id=?'); $st->execute([(int)(body_json()['id']??0)]); json_response(['ok'=>true]);
            case 'save_assignment':
                $d=body_json(); $id=(int)($d['id']??0); $code=trim((string)($d['assignment_code']??'')); $name=trim((string)($d['assignment_name']??''));
                if ($code===''||$name==='') json_response(['error'=>'กรุณากรอกรหัสและชื่องาน'],422);
                $due=trim((string)($d['due_date']??'')); $due=$due===''?null:str_replace('T',' ',$due).(strlen($due)===16?':00':'');
                $pdo->beginTransaction();
                if ($id) { $st=$pdo->prepare('UPDATE assignments SET assignment_code=?,assignment_name=?,subject=?,description=?,due_date=?,status=? WHERE id=?'); $st->execute([$code,$name,$d['subject']?:null,$d['description']?:null,$due,$d['status']??'active',$id]); }
                else { $st=$pdo->prepare('INSERT INTO assignments(assignment_code,assignment_name,subject,description,due_date,qr_token) VALUES(?,?,?,?,?,?)'); $st->execute([$code,$name,$d['subject']?:null,$d['description']?:null,$due,valid_token()]); $id=(int)$pdo->lastInsertId(); }
                $pdo->exec("INSERT IGNORE INTO submissions(student_id,assignment_id,status) SELECT id,".(int)$id.", 'pending' FROM students WHERE status='active'");
                $pdo->commit(); json_response(['ok'=>true]);
            case 'delete_assignment':
                $st=$pdo->prepare('DELETE FROM assignments WHERE id=?'); $st->execute([(int)(body_json()['id']??0)]); json_response(['ok'=>true]);
            case 'scan':
                $d=body_json(); $raw=trim((string)($d['value']??''));
                if (preg_match('/^(STU|ASSIGN):([a-f0-9]{32})$/i',$raw,$m)) { $type=strtoupper($m[1]); $token=strtolower($m[2]); }
                else json_response(['error'=>'QR ไม่ถูกต้องหรือไม่รู้จักประเภท'],422);
                if ($type==='STU') { $st=$pdo->prepare("SELECT id,student_code,student_name,class_name,student_number,qr_token FROM students WHERE qr_token=? AND status='active'"); $st->execute([$token]); $r=$st->fetch(); if(!$r)json_response(['error'=>'ไม่พบนักเรียน หรือถูกปิดใช้งาน'],404); json_response(['type'=>'student','record'=>$r]); }
                $st=$pdo->prepare("SELECT id,assignment_code,assignment_name,subject,due_date,qr_token FROM assignments WHERE qr_token=? AND status='active'"); $st->execute([$token]); $r=$st->fetch(); if(!$r)json_response(['error'=>'ไม่พบงาน หรือถูกปิดใช้งาน'],404); json_response(['type'=>'assignment','record'=>$r]);
            case 'submission_check':
                $d=body_json(); $st=$pdo->prepare("SELECT sub.*,a.assignment_name,a.assignment_code,a.due_date,s.student_name,s.student_code FROM submissions sub JOIN assignments a ON a.id=sub.assignment_id JOIN students s ON s.id=sub.student_id WHERE sub.student_id=? AND sub.assignment_id=?"); $st->execute([(int)($d['student_id']??0),(int)($d['assignment_id']??0)]); $r=$st->fetch(); json_response(['existing'=>$r?:null]);
            case 'receive':
                $d=body_json(); $sid=(int)($d['student_id']??0); $aid=(int)($d['assignment_id']??0);
                $st=$pdo->prepare("INSERT IGNORE INTO submissions(student_id,assignment_id,status,submitted_at) SELECT s.id,a.id,IF(a.due_date IS NOT NULL AND CURRENT_TIMESTAMP>a.due_date,'late','submitted'),CURRENT_TIMESTAMP FROM students s JOIN assignments a WHERE s.id=? AND s.status='active' AND a.id=? AND a.status='active'"); $st->execute([$sid,$aid]);
                if ($st->rowCount()===0) json_response(['error'=>'งานนี้ถูกส่งแล้ว หรือไม่พบรายการที่ใช้งาน'],409);
                json_response(['ok'=>true]);
            case 'report':
                $aid=(int)($_GET['assignment_id']??0); $sid=(int)($_GET['student_id']??0); $q=trim((string)($_GET['q']??''));
                $sql="SELECT sub.*,s.student_code,s.student_name,s.class_name,s.student_number,a.assignment_code,a.assignment_name,a.subject,a.due_date FROM submissions sub JOIN students s ON s.id=sub.student_id JOIN assignments a ON a.id=sub.assignment_id WHERE (?=0 OR a.id=?) AND (?=0 OR s.id=?) AND (?='' OR s.student_code LIKE ? OR s.student_name LIKE ? OR a.assignment_code LIKE ? OR a.assignment_name LIKE ?) ORDER BY a.id DESC,s.class_name,s.student_number LIMIT 2000";
                $like="%$q%";$st=$pdo->prepare($sql);$st->execute([$aid,$aid,$sid,$sid,$q,$like,$like,$like,$like]);json_response($st->fetchAll());
            case 'grade':
                $d=body_json(); $status=(string)($d['status']??'submitted'); $allowed=['submitted','checking','checked','returned','late']; if(!in_array($status,$allowed,true))json_response(['error'=>'สถานะไม่ถูกต้อง'],422);
                $score=($d['score']??'')===''?null:(float)$d['score']; $max=($d['max_score']??'')===''?null:(float)$d['max_score']; if($score!==null&&($score<0||($max!==null&&$score>$max)))json_response(['error'=>'คะแนนไม่ถูกต้อง'],422);
                $st=$pdo->prepare('UPDATE submissions SET status=?,score=?,max_score=?,remark=?,checked_at=IF(?="checked",CURRENT_TIMESTAMP,checked_at) WHERE id=?');$st->execute([$status,$score,$max,trim((string)($d['remark']??''))?:null,$status,(int)($d['id']??0)]);json_response(['ok'=>true]);
            default: json_response(['error'=>'Unknown API action'],404);
        }
    } catch (PDOException $ex) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ((string)$ex->getCode()==='23000') json_response(['error'=>'รหัสนี้ถูกใช้แล้ว หรือข้อมูลซ้ำ'],409);
        error_log($ex->getMessage()); json_response(['error'=>'เกิดข้อผิดพลาดในฐานข้อมูล'],500);
    }
}

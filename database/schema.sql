CREATE DATABASE IF NOT EXISTS studentsend CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE studentsend;

CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  role ENUM('admin','teacher') NOT NULL DEFAULT 'teacher',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE students (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_code VARCHAR(50) NOT NULL UNIQUE,
  student_name VARCHAR(255) NOT NULL,
  class_name VARCHAR(100) NULL,
  student_number INT NULL,
  qr_token CHAR(32) NOT NULL UNIQUE,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_students_class_number(class_name,student_number), INDEX idx_students_name(student_name)
) ENGINE=InnoDB;
CREATE TABLE assignments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  assignment_code VARCHAR(50) NOT NULL UNIQUE,
  assignment_name VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NULL,
  description TEXT NULL,
  due_date DATETIME NULL,
  qr_token CHAR(32) NOT NULL UNIQUE,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_assignment_due(due_date), INDEX idx_assignment_name(assignment_name)
) ENGINE=InnoDB;
CREATE TABLE submissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT UNSIGNED NOT NULL,
  assignment_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','submitted','checking','checked','returned','late') NOT NULL DEFAULT 'pending',
  submitted_at DATETIME NULL,
  checked_at DATETIME NULL,
  score DECIMAL(6,2) NULL,
  max_score DECIMAL(6,2) NULL,
  remark TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_submission_student FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_submission_assignment FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  CONSTRAINT uq_submission_student_assignment UNIQUE(student_id,assignment_id),
  INDEX idx_submission_status(status), INDEX idx_submission_assignment_status(assignment_id,status), INDEX idx_submission_student_status(student_id,status)
) ENGINE=InnoDB;

-- Create the first teacher account with: php tools/create_user.php admin "School Administrator"

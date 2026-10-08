-- REVIEW ONLY: not applied. No USE, migration runner, backfill or existing row changes.

-- MySQL >= 8.0.16 / InnoDB. Validate in a separately authorized disposable environment.

-- Existing users/personal_memos/personal_memo_images must exist; preserve their IDs.

-- Explicit utf8mb4_bin keeps opaque IDs/request IDs case-sensitive across installations.

-- Generated from app/memo_sync_models.py through the offline harness.

CREATE TABLE memo_sync_devices (
	id VARCHAR(36) NOT NULL,
	owner_user_id INTEGER NOT NULL,
	namespace VARCHAR(100) NOT NULL,
	name VARCHAR(80) NOT NULL,
	token_hash VARCHAR(64) NOT NULL,
	expires_at DATETIME NOT NULL,
	revoked_at DATETIME,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(owner_user_id) REFERENCES users (id),
	UNIQUE (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_memo_sync_devices_owner_user_id ON memo_sync_devices (owner_user_id);

CREATE TABLE memo_sync_documents (
	id VARCHAR(36) NOT NULL,
	owner_user_id INTEGER NOT NULL,
	namespace VARCHAR(100) NOT NULL,
	type VARCHAR(12) NOT NULL,
	`key` VARCHAR(36) NOT NULL,
	version INTEGER NOT NULL,
	deleted BOOL NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_memo_sync_unit UNIQUE (owner_user_id, namespace, type, `key`),
	CONSTRAINT ck_memo_sync_type CHECK (type IN ('DAY', 'NEXT_LIST')),
	CONSTRAINT ck_memo_sync_version CHECK (version >= 1),
	FOREIGN KEY(owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_memo_sync_documents_owner_user_id ON memo_sync_documents (owner_user_id);

CREATE TABLE personal_memo_lists (
	id VARCHAR(36) NOT NULL,
	owner_user_id INTEGER NOT NULL,
	title VARCHAR(120) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_personal_memo_lists_owner_user_id ON personal_memo_lists (owner_user_id);

CREATE TABLE memo_sync_authorizations (
	id VARCHAR(64) NOT NULL,
	namespace VARCHAR(100) NOT NULL,
	name VARCHAR(80) NOT NULL,
	challenge VARCHAR(43) NOT NULL,
	state VARCHAR(128) NOT NULL,
	redirect_uri VARCHAR(200) NOT NULL,
	owner_user_id INTEGER,
	code_hash VARCHAR(64),
	expires_at DATETIME NOT NULL,
	consumed_at DATETIME,
	device_id VARCHAR(36),
	PRIMARY KEY (id),
	FOREIGN KEY(owner_user_id) REFERENCES users (id),
	UNIQUE (code_hash),
	FOREIGN KEY(device_id) REFERENCES memo_sync_devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE memo_sync_conflicts (
	id VARCHAR(36) NOT NULL,
	document_id VARCHAR(36) NOT NULL,
	device_id VARCHAR(36) NOT NULL,
	source VARCHAR(12) NOT NULL,
	base_version INTEGER NOT NULL,
	local_version INTEGER NOT NULL,
	proposed JSON NOT NULL,
	server_snapshot JSON NOT NULL,
	resolved_version INTEGER,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(document_id) REFERENCES memo_sync_documents (id),
	FOREIGN KEY(device_id) REFERENCES memo_sync_devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_memo_sync_conflicts_document_id ON memo_sync_conflicts (document_id);

CREATE TABLE memo_sync_image_pins (
	document_id VARCHAR(36) NOT NULL,
	image_id INTEGER NOT NULL,
	PRIMARY KEY (document_id, image_id),
	FOREIGN KEY(document_id) REFERENCES memo_sync_documents (id),
	FOREIGN KEY(image_id) REFERENCES personal_memo_images (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE memo_sync_links (
	id VARCHAR(36) NOT NULL,
	document_id VARCHAR(36) NOT NULL,
	device_id VARCHAR(36) NOT NULL,
	active BOOL NOT NULL,
	ack_version INTEGER NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(document_id) REFERENCES memo_sync_documents (id),
	FOREIGN KEY(device_id) REFERENCES memo_sync_devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_memo_sync_link_device_active ON memo_sync_links (device_id, active, document_id);

CREATE INDEX ix_memo_sync_links_device_id ON memo_sync_links (device_id);

CREATE INDEX ix_memo_sync_links_document_id ON memo_sync_links (document_id);

CREATE TABLE memo_sync_requests (
	device_id VARCHAR(36) NOT NULL,
	request_id VARCHAR(64) NOT NULL,
	digest VARCHAR(64) NOT NULL,
	result JSON NOT NULL,
	PRIMARY KEY (device_id, request_id),
	FOREIGN KEY(device_id) REFERENCES memo_sync_devices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE memo_sync_revisions (
	id INTEGER NOT NULL AUTO_INCREMENT,
	document_id VARCHAR(36) NOT NULL,
	version INTEGER NOT NULL,
	snapshot JSON NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_memo_sync_revision UNIQUE (document_id, version),
	FOREIGN KEY(document_id) REFERENCES memo_sync_documents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_memo_sync_revisions_document_id ON memo_sync_revisions (document_id);

CREATE TABLE memo_sync_uploads (
	device_id VARCHAR(36) NOT NULL,
	request_id VARCHAR(64) NOT NULL,
	digest VARCHAR(64) NOT NULL,
	image_id INTEGER NOT NULL,
	PRIMARY KEY (device_id, request_id),
	FOREIGN KEY(device_id) REFERENCES memo_sync_devices (id),
	FOREIGN KEY(image_id) REFERENCES personal_memo_images (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE memo_sync_changes (
	id INTEGER NOT NULL AUTO_INCREMENT,
	device_id VARCHAR(36) NOT NULL,
	link_id VARCHAR(36) NOT NULL,
	document_id VARCHAR(36) NOT NULL,
	version INTEGER NOT NULL,
	kind VARCHAR(16) NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(device_id) REFERENCES memo_sync_devices (id),
	FOREIGN KEY(link_id) REFERENCES memo_sync_links (id),
	FOREIGN KEY(document_id) REFERENCES memo_sync_documents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_memo_sync_change_device_cursor ON memo_sync_changes (device_id, id);

CREATE INDEX ix_memo_sync_changes_device_id ON memo_sync_changes (device_id);

CREATE TABLE personal_memo_list_items (
	memo_id INTEGER NOT NULL,
	list_id VARCHAR(36) NOT NULL,
	PRIMARY KEY (memo_id),
	FOREIGN KEY(memo_id) REFERENCES personal_memos (id),
	FOREIGN KEY(list_id) REFERENCES personal_memo_lists (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX ix_personal_memo_list_items_list_id ON personal_memo_list_items (list_id);

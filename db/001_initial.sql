BEGIN;
CREATE TABLE concepts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL,
 title text NOT NULL, description text NOT NULL,
 prerequisites_dag jsonb NOT NULL DEFAULT '[]', target_concept text NOT NULL
);
CREATE TABLE challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), concept_id uuid NOT NULL REFERENCES concepts(id),
 title text NOT NULL, starter_code text NOT NULL, baseline_kernel text NOT NULL,
 target_metric text NOT NULL, threshold double precision NOT NULL CHECK (threshold >= 0 AND threshold < 'Infinity'::float8)
);
CREATE TABLE submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
 challenge_id uuid REFERENCES challenges(id), code text NOT NULL CHECK (octet_length(code) BETWEEN 1 AND 65536),
 language text NOT NULL CHECK (language IN ('python','pytorch','triton')),
 status text NOT NULL CHECK (status IN ('queued','compiling','running','completed','failed','timed_out')),
 created_at timestamptz NOT NULL DEFAULT now(), request jsonb NOT NULL,
 error text
);
CREATE TABLE benchmark_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submission_id uuid UNIQUE NOT NULL REFERENCES submissions(id),
 latency_ms double precision NOT NULL CHECK (latency_ms > 0 AND latency_ms < 'Infinity'::float8),
 memory_throughput_gbps double precision NOT NULL CHECK (memory_throughput_gbps >= 0 AND memory_throughput_gbps < 'Infinity'::float8),
 compute_tflops double precision NOT NULL CHECK (compute_tflops >= 0 AND compute_tflops < 'Infinity'::float8),
 arithmetic_intensity double precision CHECK (arithmetic_intensity >= 0 AND arithmetic_intensity < 'Infinity'::float8),
 pcie_transfer_ms double precision CHECK (pcie_transfer_ms >= 0 AND pcie_transfer_ms < 'Infinity'::float8),
 passed boolean, result jsonb NOT NULL
);
CREATE INDEX submissions_created_at_idx ON submissions(created_at);
CREATE INDEX submissions_user_id_idx ON submissions(user_id);
COMMIT;
-- prerequisites_dag holds prerequisite concept UUIDs. Application-level cycle
-- validation is required before exposing concept mutation APIs.

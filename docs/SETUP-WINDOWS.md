# คู่มือติดตั้ง Execution Sandbox บนเครื่องนี้ (Windows 11 / Dell Latitude 5520)

เอกสารนี้เขียนจาก **ผลตรวจเครื่องจริง** (ดูคำสั่งตรวจซ้ำได้ใน `runner/check-env.ps1`)
ไม่ใช่คู่มือทั่วไป — ทุกค่าที่อ้างถึงถูกวัดจากเครื่องนี้

## 1. สภาพเครื่องที่ตรวจแล้ว (17 ก.ย. 2026)

| รายการ | ค่าที่วัดได้ | ความหมาย |
| --- | --- | --- |
| OS | Windows 11 Pro build 26200 (x64) | รองรับ WSL2 เต็มรูปแบบ |
| สิทธิ์ | elevated (Administrator) = True | ติดตั้ง WSL/Docker ได้ |
| CPU | Intel Core i5-1135G7, 4C / 8T | จำกัด container ที่ 2 CPU |
| GPU | **Intel Iris Xe เท่านั้น (ไม่มี NVIDIA)** | **CUDA/Triton รันบนเครื่องนี้ไม่ได้** |
| RAM | 15.7 GB | ต้อง cap memory ของ WSL2 |
| ดิสก์ | D: ว่าง 584 GB, C: ว่าง 93 GB | พอสำหรับ image CPU-only (~3-4 GB) |
| Hypervisor | present = True | VT-x เปิดอยู่ |
| WSL | ยังไม่ติดตั้ง | ต้องติดตั้ง + reboot 1 ครั้ง |
| Docker | ไม่มี (ไม่มี CLI/daemon) | ต้องติดตั้ง |
| Python | มีแต่ Microsoft Store alias | ไม่มี interpreter จริง |
| Node.js | v24.19.0 | ใช้รัน playground + tests ได้แล้ว |
| Git | มี (`C:\Program Files\Git`) | พร้อม |

### ข้อสรุปที่สำคัญที่สุด

**เครื่องนี้ไม่สามารถรัน CUDA หรือ OpenAI Triton ได้** เพราะไม่มี NVIDIA GPU
และ Docker บน WSL2 ส่งผ่าน GPU ได้เฉพาะ NVIDIA (ต้องมี `nvidia-container-toolkit`)

สิ่งที่ยังทำได้จริงและมีคุณค่าต่อโปรเจกต์:

- **CPU execution จริง**: รัน Python/PyTorch (CPU wheel) ใน container ที่จำกัด CPU/RAM ได้
  และวัดเวลาจริง (median ของ repetitions) → `provenance.timing = "measured"` เป็นความจริงได้
- **Roofline model ทำงานเต็มรูปแบบบน CPU** เพราะเป็นแบบจำลองเชิงสถาปัตยกรรม
  ไม่ผูกกับ CUDA — ใช้แยก "memory bound vs compute bound" ได้เหมือนเดิม
  (ตัวอย่าง CPU socket class: peak ~0.8 TFLOP/s fp32, DDR ~60 GB/s → ridge point ~13 FLOP/byte)
- **Triton/CUDA path** ต้องระบุว่า "ไม่รองรับบน host นี้" ไม่ใช่ส่งไปรันแล้ว error มั่ว

ทางเลือก GPU ที่เป็นไปได้ถ้าต้องการจริง (นอกขอบเขตตอนนี้):

- ย้าย worker ไป cloud GPU VM (เช่น RunPod/Lambda/AWS g5) — contract ที่วางไว้ใช้ได้ทันที
- iGPU ของ Intel รันได้ผ่าน `torch-directml` หรือ IPEX-XPU แต่: **ไม่มี CUDA events**,
  **Triton ใช้ไม่ได้**, ให้ผลการวัดคนละความหมาย — ผมไม่แนะนำให้ติดตั้งบน host ตรง ๆ
  เพราะมันจะทำให้ตัวเลข "ดูเหมือน CUDA" แต่ไม่ใช่

## 2. สถาปัตยกรรมที่แนะนำบนเครื่องนี้

```
Windows 11 (D:\Usui\Mentat)
  ├─ Node.js 24 ......... Next.js playground + contract tests   [ติดตั้งแล้ว]
  └─ WSL2 Ubuntu (แนะนำ)
        ├─ Docker Engine + dockerd ......... spawn runner containers
        ├─ FastAPI gateway (uvicorn) ....... /api/v1 + WebSocket
        ├─ Celery worker ................... job queue consumer
        └─ Redis + PostgreSQL .............. broker/replay + persistence
```

**แนะนำ: Docker Engine ใน WSL2 Ubuntu (ไม่ใช้ Docker Desktop)** เพราะ

1. runner/worker เป็นงานฝั่ง Linux อยู่แล้ว — วางไว้ข้าง dockerd ทำให้ path และ cgroup limit
   ตรงกับ production มากที่สุด
2. ไม่มี overhead ของ GUI และไม่ติดเงื่อนไขลิขสิทธิ์ Docker Desktop สำหรับองค์กร
3. จำกัด CPU/RAM ด้วย cgroup v2 ได้ตามที่ contract ต้องการ (`--cpus`, `--memory`, `--pids-limit`)

ถ้าต้องการสั่ง `docker` จาก PowerShell ด้วยความสะดวก ใช้ Docker Desktop แทนได้
(WSL2 backend) — แต่ต้องเปิดแอปค้างไว้ และ worker ควรอยู่ใน WSL อยู่ดี

### ข้อควรระวังเรื่อง path

repo อยู่ที่ `D:\Usui\Mentat` ซึ่งมองจาก WSL เป็น `/mnt/d/Usui/Mentat`
การอ่าน/เขียนผ่าน `/mnt/d` ช้ากว่า filesystem ของ Linux มาก (~5-10 เท่าบนงาน I/O เล็กจำนวนมาก)
สำหรับ build image ขนาดเล็กยอมรับได้ แต่ถ้าจะรันชุดทดสอบหนัก ๆ ให้ copy เข้า `~/kernelforge`

## 3. ขั้นตอนติดตั้ง (ตามลำดับ ห้ามข้าม)

### ขั้นที่ 1 — ติดตั้ง WSL2 + Ubuntu

เปิด **PowerShell แบบ Administrator** แล้วรัน (ผมรันคำสั่งนี้ให้ได้ แต่เครื่องจะ reboot):

```powershell
wsl --install -d Ubuntu
```

- ดาวน์โหลด ~500 MB และ **ต้อง reboot 1 ครั้ง**
- หลัง reboot Ubuntu จะเปิดให้ตั้ง username/password (จำ password ไว้ ใช้กับ `sudo`)
- ตรวจผล: `wsl -l -v` ต้องเห็น Ubuntu สถานะ `Running` และ `VERSION 2`

### ขั้นที่ 2 — จำกัดทรัพยากรของ WSL2 (สำคัญมากบน RAM 15.7 GB)

สร้างไฟล์ `C:\Users\IT_Programmer6\.wslconfig` (ยังไม่มีในเครื่อง):

```ini
[wsl2]
memory=8GB
processors=4
swap=2GB
# ที่เก็บข้อมูลของ distro ย้ายไป D: ได้ถ้า C: ใกล้เต็ม
# (ต้องปิด WSL ก่อน: wsl --shutdown)
```

แล้วรัน `wsl --shutdown` หนึ่งครั้ง เพื่อให้ค่ามีผล
เหตุผล: ค่า default ของ WSL2 คือใช้ RAM ได้ถึง 50% ของเครื่อง (≈7.9 GB) บวก cache ของ Docker/Postgres
ถ้าไม่ cap จะทำให้ Windows เริ่ม swap จน benchmark ฝั่ง host เพี้ยน

### ขั้นที่ 3 — ติดตั้ง Docker Engine ใน Ubuntu (ไม่ใช่ Docker Desktop)

เปิด Ubuntu (จาก Start Menu หรือ `wsl`) แล้วรันตามลำดับ:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git python3 python3-venv python3-pip
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo usermod -aG docker $USER        # แล้วปิด-เปิด WSL ใหม่ (exit แล้ว wsl เข้ามาใหม่)
sudo service docker start            # WSL ไม่มี systemd โดยค่าเริ่มต้น จึงใช้ service
docker run --rm hello-world          # ต้องเห็น "Hello from Docker!"
```

ตรวจว่า cgroup limit ทำงาน (จำเป็นสำหรับ sandbox ของโปรเจกต์นี้):

```bash
docker run --rm --cpus=2 --memory=4g --pids-limit=512 --network=none \
  python:3.12-slim python -c "print('sandbox limits OK')"
```

ถ้าคำสั่งนี้ผ่าน = worker ในขั้นที่ 2 ของโปรเจกต์รันได้จริงบนเครื่องนี้

หมายเหตุ: ถ้า WSL เวอร์ชันใหม่เปิด systemd ให้ใช้ `sudo systemctl enable --now docker` แทน
และแก้ให้ docker เริ่มอัตโนมัติเมื่อเปิด WSL (เพิ่ม `sudo service docker start` ใน `~/.bashrc`
หรือตั้ง systemd=true ใน `.wslconfig`)

### ขั้นที่ 4 — เข้าถึงโปรเจกต์และรันทดสอบ

```bash
# ใน WSL
cd /mnt/d/Usui/Mentat

# ตรวจความพร้อมจากฝั่ง Windows (รันใน PowerShell)
powershell -ExecutionPolicy Bypass -File runner/check-env.ps1
```

ต้องได้ `RESULT: READY for the Linux container runner (CPU execution).`

### ขั้นที่ 5 — Python บน Windows (ไม่บังคับ)

worker กับ sandbox รันใน Linux container ทั้งหมด จึง **ไม่จำเป็นต้องมี Python บน Windows**
แต่ถ้าต้องการรัน unittest/สคริปต์เร็ว ๆ บน host:

```powershell
winget install --id Python.Python.3.12 -e
# แล้วปิด Store alias: Settings > Apps > Advanced app settings > App execution aliases
# ปิด "python.exe" และ "python3.exe" ไม่ให้ชี้ไปที่ Microsoft Store
python --version   # ต้องได้ Python 3.12.x
```

## 4. ตรวจหลังติดตั้ง (checklist)

| # | คำสั่ง | ผลที่ต้องได้ |
| --- | --- | --- |
| 1 | `wsl -l -v` (PowerShell) | Ubuntu, STATE=Running, VERSION=2 |
| 2 | `free -h` (ใน WSL) | total ≈ 7.9 Gi (ตาม `.wslconfig`) |
| 3 | `nproc` (ใน WSL) | 4 |
| 4 | `docker run --rm hello-world` | Hello from Docker! |
| 5 | `docker info --format '{{.CgroupVersion}}'` | `2` (cgroup v2 → จำกัด CPU/RAM ได้แม่น) |
| 6 | `python3 --version` (ใน WSL) | Python 3.10+ |
| 7 | `powershell -File runner/check-env.ps1` | `RESULT: READY ...` |
| 8 | `nvidia-smi` | **จะล้มเหลวบนเครื่องนี้** — คาดหมายไว้แล้ว |

## 5. ผลกระทบต่อ API contract (ต้องแก้ตอนทำ backend)

เพราะ host ไม่มี CUDA ระบบต้อง **ถาม capability ก่อน แล้วปฏิเสธงานที่รันไม่ได้**
ผมเพิ่มสิ่งนี้ใน `contracts/API.md` แล้ว:

- `GET /api/v1/capabilities` → `{cpu: true, cuda: false, languages: {python: true, pytorch: true, triton: false}, ...}`
- `POST /submissions` ที่ส่ง `device=cuda` หรือ `language=triton` บน host ที่ไม่มี CUDA
  → **422** พร้อม `detail.code = "unsupported_device"` (ไม่ใช่ queue แล้วไปตายใน container)
- UI ฝั่ง playground ต้อง disable ตัวเลือก cuda/Triton เมื่อ capability บอกว่าไม่มี
  (ตอนนี้ยังเลือกได้ เพราะเป็น simulation — จะเปิดใช้เมื่อ backend พร้อม)

เหตุผลเชิงออกแบบ: ถ้าปล่อยให้ queue งานที่รันไม่ได้ ผู้ใช้จะได้ `failed` ที่สับสน
และเสียเวลา container start ไปเปล่า ๆ — capability probe ถูกกว่าและซื่อสัตย์กว่า

## 6. งานส่วนไหนที่ผมรันให้ได้ / ส่วนไหนต้องรันเอง

| งาน | ผมรันให้ได้ตอนนี้ | ต้องรันเอง |
| --- | --- | --- |
| `runner/check-env.ps1` (ตรวจเครื่อง) | ได้ (รันแล้ว) | — |
| `wsl --install -d Ubuntu` | ได้ แต่ **เครื่องจะ reboot** | ต้องตั้ง username/password หลัง reboot |
| เขียน `.wslconfig` | ได้ (ถ้าสั่ง) | — |
| ติดตั้ง Docker Engine ใน WSL | ได้ **หลัง** WSL พร้อม | — |
| `winget install Python.Python.3.12` | ได้ | ต้องปิด Store alias ผ่าน GUI |
| ติดตั้ง NVIDIA driver | ทำไม่ได้ (ไม่มี GPU) | — |

## 7. ขอบเขตที่ยืนยันแล้ว

รอบ implementation ปัจจุบันใช้ **CPU MVP** เท่านั้น: FastAPI, Celery, Redis, PostgreSQL และ
Docker runner พร้อม Python/PyTorch CPU; CUDA/Triton รองรับเชิงสัญญาแต่ยังไม่มี worker
บนเครื่องนี้ และไม่ได้สั่งติดตั้ง WSL2 เพราะต้องรีสตาร์ทเครื่อง เมื่อพร้อมให้ทำตามขั้นตอน
ในคู่มือนี้แล้วรัน `docker compose up --build`.

ค่า `provenance.timing = measured` หมายถึงเวลาที่วัดใน container จริง ส่วน
`provenance.workload` จะเป็น `user_estimate` สำหรับ `declared` และ `protocol` เมื่อ metadata
มาจาก `benchmark()`; โหมด local simulation จะรายงาน `user_estimate` เสมอ

**ห้าม** ติดตั้ง `torch`/`triton` บน Windows host สำหรับโปรเจกต์นี้ — โค้ดของผู้ใช้ต้องรันใน
container ที่ถูกจำกัดสิทธิ์เท่านั้น (ดู `contracts/API.md`)

### ขั้นที่ 6 — GPU passthrough (คำตอบตรง ๆ: เครื่องนี้ทำไม่ได้)

สิ่งที่ต้องมีถ้าจะรัน CUDA ใน container (สำหรับเครื่องอื่น/cloud):

```bash
# 1) ฝั่ง Windows: ติดตั้ง NVIDIA driver เวอร์ชันใหม่ (driver เดียวรองรับทั้ง Windows และ WSL)
# 2) ใน WSL: ตรวจว่าเห็น GPU
nvidia-smi
# 3) ติดตั้ง toolkit ใน WSL Ubuntu
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo service docker restart
# 4) ทดสอบ
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

บนเครื่องนี้ขั้นที่ 2 จะล้มเหลวเพราะไม่มี `/dev/nvidia*` — จึงควรออกแบบให้ระบบ
**ตรวจ capability ก่อนรับงาน** (ดูหัวข้อ 5)

### ขั้นที่ 7 — ย้อนกลับ/ถอนการติดตั้ง (ถ้าต้องการ)

```powershell
wsl --unregister Ubuntu     # ลบ distro และข้อมูลทั้งหมดในนั้น
wsl --uninstall             # ถอน WSL component
```

ลบไฟล์ `C:\Users\IT_Programmer6\.wslconfig` ถ้าไม่ต้องการค่า cap อีก
หรือใช้ VS Code Remote-WSL แล้วทำงานใน home directory
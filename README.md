# IDX Scalping Sniper 🚀

![Hacker Theme Banner](https://user-images.githubusercontent.com/674621/210176084-6d8b5b8e-6b9e-4e7a-8b6e-2e7e8c2e7b3d.png)

> **IDX Scalping Sniper**  
> Terminal-based real-time stock screener & REST API for Indonesia Stock Exchange (IDX)  
> **By Fattan Malva**

---

## ✨ Fitur Utama

- **REST API** data saham IDX (Yahoo Finance) — auto refresh tiap 1 menit
- **Super cepat** & ringan, cocok untuk trader aktif

---

## 🚦 Cara Pakai

### 1. Clone & Install

```bash
git clone https://github.com/Fattan-malva/Sniper-IHSG-NodeJS.git
cd Sniper-IHSG-Deployment
npm install
```

### 2. Siapkan Data Kode Saham

Pastikan file `stockcode.csv` sudah ada di folder utama.  
Format minimal:
```
Code
BBCA
BBRI
TLKM
UNVR
...
```

### 3. Jalankan REST API

```bash
npm start
```
Server berjalan di: [http://localhost:3000/api/stocks](http://localhost:3000/api/stocks)

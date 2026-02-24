# Light RJ Worker

This actor automates the login process for the Light RJ portal (https://agenciavirtual.light.com.br/portal/).
It handles reCAPTCHA v2 using `puppeteer-extra-plugin-stealth` for click-based solving, with a fallback to Anti-Captcha API.

## Prerequisites

- Node.js installed.
- Anti-Captcha API Key (optional, but recommended for reliability).

## Installation

```bash
cd actors/light-rj
npm install
```

## Usage

You can run the worker locally using `npm start`.

### Input

The worker requires an input object with `username` and `password`. You can provide this via:

1.  **Apify Console** (if deployed).
2.  **Local `storage/key_value_stores/default/INPUT.json`** file.
3.  **Environment Variables** (for Anti-Captcha key).

**Example `INPUT.json`:**

```json
{
    "username": "YOUR_CPF_OR_EMAIL",
    "password": "YOUR_PASSWORD",
    "antiCaptchaKey": "YOUR_API_KEY_OPTIONAL"
}
```

### Environment Variables

-   `ANTI_CAPTCHA_KEY`: Your Anti-Captcha API key. If not provided in input, this env var is used.

## Configuration

 The worker uses `playwright-extra` with `stealth` plugin to attempt to bypass bot detection.
 If the captcha cannot be solved by a simple click, it will use the Anti-Captcha API to solve it.

## Troubleshooting

-   **Captcha not solved**: Ensure you have a valid Anti-Captcha key and sufficient balance.
-   **Login failed**: Check credentials and internet connection. Screenshots of errors are saved in the default key-value store.

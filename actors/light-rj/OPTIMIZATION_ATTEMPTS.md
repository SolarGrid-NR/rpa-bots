# Light RJ Worker Performance Optimization Attempts

**Date:** February 24, 2026
**Context:** We attempted to optimize the execution time of the `light-rj` Playwright worker, aiming to reduce the average run time from ~110 seconds to under 50 seconds. Ultimately, the changes were rolled back because the optimization techniques compromised the bot's reliability, and success rate is the paramount metric.

This document serves as a historical record of what was tried and why it failed, to inform any future optimization efforts.

## The Goal
Significantly reduce execution time by eliminating dead waits, parallelizing tasks, and optimizing element locators, while maintaining a 100% success rate.

## Strategies Attempted

### 1. Parallelizing Captcha with Form Fill
- **Approach:** Extract the reCAPTCHA `siteKey` immediately upon page load (before filling the form). Fire the Anti-Captcha API request as a non-blocking Promise, and fill the username/password fields concurrently while waiting for the captcha solution.
- **Result:** Conceptually worked and saved ~2-3 seconds, but introduced timing complexities when the form filled faster than the captcha solved.

### 2. Replacing `networkidle` with `domcontentloaded`
- **Approach:** Changed all `page.goto()` calls to use `waitUntil: 'domcontentloaded'` instead of `networkidle`, assuming we could just wait for specific DOM elements to appear.
- **Result:** Failed. The Light RJ portal is built on the OutSystems framework, which relies heavily on post-load AJAX requests to render the actual page content (like the accordion framework). `domcontentloaded` fired too early, causing the bot to search for elements that the server hadn't injected yet.

### 3. Eliminating Hardcoded Waits & Aggressive AJAX Optimization
- **Approach:** Removed all `waitForTimeout(3000)` calls (e.g., after login submission, after captcha injection). Attempted to bypass waiting for the `.Feedback_AjaxWait` spinner entirely.
- **Result:** Broke the pipeline. Removing the 3-second settle time after injecting the captcha token caused the site to frequently reject the login with a "Por favor, selecione Não sou robô" error. The OutSystems/React bindings needed that physical time to register the injected token before the "ENTRAR" click.

### 4. Streamlined Login Validation
- **Approach:** Replaced a long sequential validation block with a `Promise.race` between the success URL (`Login.aspx`) and the `.Feedback_Message_Error` banner becoming visible.
- **Result:** Worked well in theory, but cascaded into issues when the captcha was rejected. The site frequently wiped the username/password fields upon a captcha rejection, which the retry logic initially didn't catch, leading to blank submissions.

### 5. Smart Page Routing (45-Day Heuristic)
- **Approach:** If the target `referenceMonth` was more than 45 days in the past, the bot was programmed to try the "Paid Bills" (Comprovante Conta Paga) page first, skipping the "Open Bills" page to save a navigation cycle.
- **Result:** Logically sound, but exposed discrepancies in the DOM structure. The "Paid Bills" page uses different CSS classes and text-matching paradigms (`:has-text` vs `:text-is`) compared to the "Open Bills" page, breaking our unified optimized locators.

## Key Learnings & Why We Rolled Back

1. **OutSystems Dictates the Pace:** The Light RJ portal's architecture makes it highly resistant to aggressive Playwright optimizations. The heavy reliance on AJAX means that `networkidle` and explicit waits for the `.Feedback_AjaxWait` spinner are mandatory for stability, even if they artificially inflate execution time.
2. **Captcha Settle Time is Non-Negotiable:** Injecting the reCAPTCHA token via JavaScript requires a physical delay (at least 2-3 seconds) before form submission. Bypassing this consistently triggers anti-bot protections.
3. **Success Rate > Speed:** In RPA billing contexts, throwing a false negative (failing to find a bill that actually exists) due to a race condition is catastrophic. The baseline code, while slow (~110s), provides the resilience needed to guarantee the bill is found if it exists.

## Future Recommendations
If optimizations are attempted again in the future:
- **Do not remove `networkidle`** on major page navigations.
- **Retain explicit waits** for the `.Feedback_AjaxWait` spinner to attach and detach when expanding modifying the DOM (like opening accordions).
- Focus on optimizing the **Anti-Captcha service itself** (e.g., switching to a faster provider like CapMonster Cloud, which averages 1-3s solves vs. Anti-Captcha's 10-20s) rather than squeezing milliseconds out of Playwright's DOM interactions.

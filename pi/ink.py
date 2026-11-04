"""Eco-Ink maths shared by the upload inspector and the AI engine.
Kept tiny (numpy + OpenCV only) so the inspector's short-lived child process starts fast: importing the whole
AI toolkit (reportlab, psutil, PDF layout...) just to measure ink cost more than the check itself."""
import cv2
import numpy as np


def eco_ink_gray(gray: np.ndarray) -> np.ndarray:
    """Dark pages are inverted, then the paper background is normalised to pure white.
    Gray levels are kept (no hard binarisation) so photos and anti-aliased text stay readable."""
    if np.median(gray) < 128:
        gray = 255 - gray
    small = cv2.resize(gray, (max(1, gray.shape[1] // 8), max(1, gray.shape[0] // 8)), interpolation=cv2.INTER_AREA)
    background = cv2.GaussianBlur(cv2.dilate(small, np.ones((7, 7), np.uint8)), (0, 0), 3)
    background = cv2.resize(background, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    normalised = gray.astype(np.float32) / np.maximum(background.astype(np.float32), 1.0) * 255.0
    return np.clip(normalised * (255.0 / 235.0), 0, 255).astype(np.uint8)


def page_needs_eco(gray72: np.ndarray) -> bool:
    small = cv2.resize(gray72, (max(1, gray72.shape[1] // 4), max(1, gray72.shape[0] // 4)), interpolation=cv2.INTER_AREA)
    bg = cv2.dilate(small, np.ones((5, 5), np.uint8))
    spread = np.percentile(bg, 95) - np.percentile(bg, 5)
    return np.median(gray72) < 225 or spread > 35
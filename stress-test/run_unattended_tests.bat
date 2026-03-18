@echo off
echo =======================================================
echo  Unattended Stress Test Automation (1,000,000 requests)
echo =======================================================
echo.

:: Ensure the script runs from the exact directory it is located in
cd /d "%~dp0"

echo [1/4] Starting 50 Workers Register Test...
echo -------------------------------------------------------
locust -f register_test_50_workers.py --host https://new.98ent.com --headless
echo.

echo [2/4] Starting 50 Workers Login Test...
echo -------------------------------------------------------
locust -f login_test_50_workers.py --host https://new.98ent.com --headless
echo.

echo [3/4] Starting 100 Workers Register Test...
echo -------------------------------------------------------
locust -f register_test_100_workers.py --host https://new.98ent.com --headless
echo.

echo [4/4] Starting 100 Workers Login Test...
echo -------------------------------------------------------
locust -f login_test_100_workers.py --host https://new.98ent.com --headless
echo.

echo =======================================================
echo  ALL TESTS COMPLETED SUCCESSFULLY!
echo =======================================================
pause

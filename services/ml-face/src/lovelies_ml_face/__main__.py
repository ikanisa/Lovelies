from pictured_ml_face.__main__ import configured_port
import uvicorn

def main():
    uvicorn.run("lovelies_ml_face.app:app", host="0.0.0.0", port=configured_port(), loop="asyncio", http="h11", ws="none", access_log=False)

if __name__ == "__main__":
    main()

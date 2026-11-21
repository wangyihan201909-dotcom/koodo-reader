import uvicorn


if __name__ == "__main__":
    uvicorn.run("research_agent.app:app", host="127.0.0.1", port=18756)

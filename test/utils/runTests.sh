#!/bin/bash

function main() {
    for FILE in test/*.test.js;
    do truffle test $FILE --compile-none;
    done
}

main $@
